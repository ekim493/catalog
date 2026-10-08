"""Test isolation. Import this before anything from catalog/: config reads
the data paths from the environment at import time, and the real data/
folder must never be touched."""
import atexit
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMP = tempfile.mkdtemp(prefix="catalog-tests-")
atexit.register(shutil.rmtree, TEMP, True)

os.environ["CATALOG_DATA_DIR"] = os.path.join(TEMP, "data")
os.environ["CATALOG_BACKUP_DIR"] = os.path.join(TEMP, "backups")
os.environ["TMDB_API_KEY"] = ""
os.environ["HIDDEN_CATEGORIES"] = ""
os.environ["ALLOW_CUSTOM_DATE_ADDED"] = "0"
# Anything that slips past the stubs fails fast instead of reaching the internet.
for name in ("TMDB", "TMDB_IMAGE", "ANILIST", "OPENLIB", "OPENLIB_COVERS", "COMICK", "AUDIBLE"):
    os.environ[f"CATALOG_{name}_BASE"] = "http://127.0.0.1:9"
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from catalog import assets, config, storage  # noqa: E402

assert os.path.realpath(config.DATA_DIR).startswith(os.path.realpath(TEMP)), config.DATA_DIR
assert os.path.realpath(config.BACKUP_DIR).startswith(os.path.realpath(TEMP)), config.BACKUP_DIR

assets.start_restore = lambda: None
assets.download_poster = lambda url: (None, None)


def reset(entries=(), details=None, tracking=None):
    """Replace the temp data folder's contents and drop the in-memory caches."""
    for path in (config.DATA_DIR, config.BACKUP_DIR):
        shutil.rmtree(path, ignore_errors=True)
    storage.ensure_storage()
    storage.atomic_write_json(config.ENTRIES_FILE, [dict(e) for e in entries])
    if details is not None:
        storage.atomic_write_json(config.DETAILS_FILE, details)
    if tracking is not None:
        storage.atomic_write_json(config.TRACKING_FILE, {"entries": tracking})
    for cached in (storage.catalog, storage.details, storage.tracking, storage.stash):
        cached._key = cached._value = None
    storage.fresh_start = False


def entry(**fields):
    """A minimal valid stored entry."""
    import uuid
    base = {"id": str(uuid.uuid4()), "title": "Title", "type": "Movie", "status": "planned",
            "date_added": "2024-01-01T00:00:00Z", "date_modified": "2024-01-01T00:00:00Z"}
    base.update(fields)
    return base
