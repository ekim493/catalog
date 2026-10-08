"""Disk persistence. entries.json is canonical and never silently replaced:
writes are atomic, every write is preceded by a backup, and an unreadable
file is refused rather than treated as empty. stash.json is user-owned too and
gets the same treatment. The sidecars are caches that tolerate corruption
because they can be rebuilt."""
import copy
import glob
import json
import os
import re
import shutil
import threading
from contextlib import contextmanager
from datetime import datetime

from . import config, model

# One lock for every file: a request may touch entries, details and posters
# in one commit, and a single lock rules out ordering deadlocks.
lock = threading.RLock()


class CorruptDataError(Exception):
    def __init__(self, detail, name="entries.json"):
        super().__init__(detail)
        self.name = name

    @property
    def message(self):
        return (f"{self.name} exists but couldn't be parsed. Refusing to read or write "
                "to avoid data loss — fix the file or restore one from data/backups/, then restart.")


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    # Make the rename itself durable, not just the file contents.
    try:
        fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except (OSError, AttributeError):
        pass


def _stat_key(path):
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return None


class _CachedFile:
    """A JSON file cached in memory and re-read when its mtime/size changes,
    so hand edits while the server runs are still picked up."""

    def __init__(self, path):
        self.path = path
        self._key = None
        self._value = None

    def _read(self):
        raise NotImplementedError

    def load(self):
        with lock:
            key = _stat_key(self.path)
            if self._value is None or key != self._key:
                self._value = self._read()
                self._key = key
            return self._value

    def _store(self, value, on_disk):
        atomic_write_json(self.path, on_disk)
        self._value = value
        self._key = _stat_key(self.path)


class Sidecar(_CachedFile):
    """{id: record} cache. Non-dict records are dropped on read."""

    def _raw(self):
        """Missing or unparseable -> None (rebuildable). Any other OS error
        propagates so it is never cached as an empty store and saved over."""
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return None

    def _read(self):
        data = self._raw()
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if isinstance(v, dict)}

    def get(self, entry_id):
        return self.load().get(entry_id)

    def snapshot(self):
        return copy.deepcopy(self.load())

    def save(self, records):
        with lock:
            self._store(records, records)

    @contextmanager
    def edit(self):
        with lock:
            records = self.snapshot()
            yield records
            self.save(records)


class TrackingFile(Sidecar):
    """tracking.json keeps its records under an "entries" key."""

    def _read(self):
        data = self._raw()
        records = data.get("entries") if isinstance(data, dict) else None
        if not isinstance(records, dict):
            return {}
        return {k: v for k, v in records.items() if isinstance(v, dict)}

    def save(self, records):
        with lock:
            self._store(records, {"entries": records})


def _prune_dir(directory, prefix, keep):
    # Only auto-named snapshots are pruned; zero-padded names sort by time.
    pattern = re.compile(rf"^{prefix}-\d{{8}}T\d{{12}}\.json$")
    names = sorted(n for n in os.listdir(directory) if pattern.match(n))
    for name in names[:max(0, len(names) - keep)]:
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass


class _UserList(_CachedFile):
    """A user-owned JSON array: backed up before every write, and refused
    (CorruptDataError) rather than read as empty when it can't be parsed."""
    prefix = ""

    def _read(self):
        name = os.path.basename(self.path)
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return []
        except ValueError as exc:
            raise CorruptDataError(str(exc), name)
        if not isinstance(data, list):
            raise CorruptDataError(f"{name} is not a JSON array", name)
        return data

    def _backup(self):
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
        name = f"{self.prefix}-{stamp}.json"
        if not os.path.exists(self.path):
            return
        # A save never goes ahead without its backup.
        os.makedirs(config.DAILY_BACKUP_DIR, exist_ok=True)
        shutil.copy2(self.path, os.path.join(config.BACKUP_DIR, name))
        # The first backup of each day goes to a separately pruned archive so
        # a burst of edits can't evict every older restore point.
        if not any(n.startswith(f"{self.prefix}-{stamp[:8]}") for n in os.listdir(config.DAILY_BACKUP_DIR)):
            shutil.copy2(self.path, os.path.join(config.DAILY_BACKUP_DIR, name))
        _prune_dir(config.BACKUP_DIR, self.prefix, config.MAX_BACKUPS)
        _prune_dir(config.DAILY_BACKUP_DIR, self.prefix, config.MAX_DAILY_BACKUPS)

    def _on_disk(self, items):
        return items

    def write(self, items):
        with lock:
            self.load()  # refuse to overwrite a corrupt file
            on_disk = self._on_disk(items)
            self._backup()
            self._store(items, on_disk)

    @contextmanager
    def edit(self):
        """Working copy under the lock; written on normal exit. Raising
        inside the block discards every change."""
        with lock:
            working = copy.deepcopy(self.load())
            yield working
            self.write(working)

    def find(self, item_id):
        return next((e for e in self.load() if isinstance(e, dict) and e.get("id") == item_id), None)


class Catalog(_UserList):
    prefix = "entries"

    def entries(self):
        """Read-only snapshot; callers must not mutate it."""
        return self.load()

    def _on_disk(self, entries):
        model.prune_references(entries)
        return [model.ordered(e) for e in entries]

    def serialized(self):
        with open(self.path, "rb") as f:
            return f.read()


class Stash(_UserList):
    prefix = "stash"


catalog = Catalog(config.ENTRIES_FILE)
details = Sidecar(config.DETAILS_FILE)
tracking = TrackingFile(config.TRACKING_FILE)
stash = Stash(config.STASH_FILE)
fresh_start = False


def ensure_storage():
    global fresh_start
    for d in (config.DATA_DIR, config.BACKUP_DIR, config.DAILY_BACKUP_DIR, config.POSTER_DIR):
        os.makedirs(d, exist_ok=True)
    # Nothing is in flight at startup, so any poster temp file is orphaned.
    for stale in glob.glob(os.path.join(config.POSTER_DIR, ".poster-*")):
        try:
            os.remove(stale)
        except OSError:
            pass
    if not os.path.exists(config.ENTRIES_FILE):
        fresh_start = True
        atomic_write_json(config.ENTRIES_FILE, [])
