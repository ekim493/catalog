"""Rebuildable per-entry assets: the details sidecar, cached collection
membership, and poster files. A poster is installed inside the locked commit
of the link it belongs to, so artwork always matches its link."""
import glob
import os
import re
import tempfile
import threading
import traceback
import urllib.request

from . import config, model, providers
from .storage import catalog, details, lock
from .util import age_seconds, is_uuid4, utc_now

_CTYPE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}


# ---------------------------------------------------------------- posters

def download_poster(url):
    """-> (ext, temp_path) or (None, None). Never touches a live poster."""
    if not model.clean_url(url):
        return None, None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
        with urllib.request.urlopen(req, timeout=config.FETCH_TIMEOUT) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not ctype.startswith("image/"):
                return None, None
            data = resp.read(config.MAX_POSTER_BYTES + 1)
    except Exception:
        return None, None
    if not data or len(data) > config.MAX_POSTER_BYTES:
        return None, None
    ext = _CTYPE_EXT.get(ctype, ".jpg")
    fd, tmp = tempfile.mkstemp(prefix=".poster-", suffix=ext, dir=config.POSTER_DIR)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except OSError:
        discard(tmp)
        return None, None
    return ext, tmp


def discard(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


def delete_poster(entry_id):
    # Ids become filenames, so anything that isn't a uuid4 is refused here
    # as well as at validation time.
    if not is_uuid4(entry_id):
        return
    for path in glob.glob(os.path.join(config.POSTER_DIR, f"{entry_id}.*")):
        discard(path)


def install_poster(entry_id, ext, tmp):
    """Call with the lock held. Returns True when the file landed."""
    if not is_uuid4(entry_id) or not tmp:
        return False
    delete_poster(entry_id)
    try:
        os.replace(tmp, os.path.join(config.POSTER_DIR, f"{entry_id}{ext}"))
        return True
    except OSError:
        discard(tmp)
        return False


def poster_exists(entry_id, record):
    ext = (record or {}).get("poster")
    return bool(ext) and os.path.isfile(os.path.join(config.POSTER_DIR, f"{entry_id}{ext}"))


# ---------------------------------------------------------------- records

def record_for(entry, records=None):
    """The entry's sidecar record, or None when it belongs to another link."""
    rec = (records if records is not None else details.load()).get(entry.get("id"))
    return rec if rec and rec.get("link") == model.link_key(entry) else None


def new_record(entry, extras, previous=None):
    rec = {"link": model.link_key(entry)}
    for key in ("url", "thumb_url", "details"):
        value = (extras or {}).get(key) or (previous or {}).get(key)
        if value:
            rec[key] = value
    return rec


def set_poster(rec, ext):
    if ext:
        rec["poster"] = ext
        rec["poster_at"] = utc_now()
    else:
        rec.pop("poster", None)
        rec.pop("poster_at", None)


def hydrate(entry, records=None):
    out = model.ordered(entry)
    kind = model.tracker_kind(entry)
    if kind:
        out["tracker_kind"] = kind  # display only; never stored
    rec = record_for(entry, records)
    if not rec:
        return out
    if out.get("link"):
        out["link"] = dict(out["link"], url=rec.get("url"))
    if rec.get("details"):
        out["details"] = rec["details"]
    if rec.get("poster"):
        version = re.sub(r"\D", "", rec.get("poster_at") or "")[:14]
        out["poster"] = f"/posters/{entry['id']}{rec['poster']}?v={version}"
    if isinstance(rec.get("members"), list):
        out["members"] = rec["members"]
    return out


def hydrate_all(entries):
    records = details.load()
    return [hydrate(e, records) for e in entries]


# ---------------------------------------------------------------- collections

def collection_identity(entry):
    """What a collection's membership and cover artwork depend on."""
    return (model.link_key(entry), entry.get("title"), bool(entry.get("collection")),
            entry.get("cover") if entry.get("collection") else None)


def set_members(rec, members, title):
    # OpenLibrary series membership is looked up by title, so the cache is
    # only valid for the title it was fetched under.
    rec["members"] = members
    rec["members_title"] = title
    rec["members_at"] = utc_now()


def cached_members(entry):
    """(members or None, stale)."""
    rec = record_for(entry)
    members = rec.get("members") if rec else None
    if not isinstance(members, list) or rec.get("members_title", entry.get("title")) != entry.get("title"):
        return None, True
    age = age_seconds(rec.get("members_at"))
    return members, age is None or age > config.COLLECTION_TTL_HOURS * 3600


def fetch_members(entry):
    link = entry.get("link") or {}
    return providers.collection_members(link.get("source"), link.get("id"), entry.get("title"))


def save_members(entry_id, members, expected_identity):
    with lock:
        current = catalog.find(entry_id)
        if not current or collection_identity(current)[:3] != expected_identity[:3]:
            return False
        with details.edit() as records:
            rec = record_for(current, records) or new_record(current, None)
            set_members(rec, members, current.get("title"))
            records[entry_id] = rec
        return True


def member_thumb(members, ref):
    for m in members or []:
        if isinstance(m, dict) and m.get("ref") == ref:
            return m.get("thumb_url")
    return None


# ---------------------------------------------------------------- restore

def _rebuild(entry):
    link = entry["link"]
    rec = providers.lookup(link["source"], link["id"], entry.get("title"))
    if rec and entry.get("collection"):
        members = fetch_members(entry)
        if members is not None:
            set_members(rec, members, entry.get("title"))
    return rec


def restore_missing():
    """Re-fetch details records and posters that linked entries lack. Every
    failure is non-fatal; the next start retries."""
    try:
        entries = [e for e in catalog.entries() if e.get("link")]
    except Exception:
        return
    records = details.load()
    updates, fetched_for, pending = {}, {}, {}

    def needs_rebuild(e):
        rec = record_for(e, records)
        return (not rec or not rec.get("url")
                or (e.get("collection") and not isinstance(rec.get("members"), list)))

    missing = [e for e in entries if needs_rebuild(e)]

    anilist = [e for e in missing if e["link"]["source"] == "anilist"]
    if anilist:
        try:
            batch = providers.lookup_anilist_batch(sorted({e["link"]["id"] for e in anilist}))
        except Exception:
            batch = {}
        for e in anilist:
            if batch.get(e["link"]["id"]):
                updates[e["id"]] = batch[e["link"]["id"]]
    for e in missing:
        if e["link"]["source"] == "anilist":
            continue
        try:
            rec = _rebuild(e)
        except Exception:
            rec = None
        if rec:
            updates[e["id"]] = rec

    for e in entries:
        rec = updates.get(e["id"]) or record_for(e, records)
        if not rec or poster_exists(e["id"], record_for(e, records)):
            continue
        url = rec.get("thumb_url")
        if e.get("collection") and e.get("cover"):
            url = member_thumb(rec.get("members"), e["cover"]) or url
        ext, tmp = download_poster(url) if url else (None, None)
        if ext:
            pending[e["id"]] = (ext, tmp)
    for e in entries:
        if e["id"] in updates or e["id"] in pending:
            fetched_for[e["id"]] = collection_identity(e)
    if not fetched_for:
        return

    try:
        with lock:
            current = {e["id"]: collection_identity(e) for e in catalog.entries()}
            with details.edit() as store:
                for eid, identity in fetched_for.items():
                    if current.get(eid) != identity:
                        continue
                    entry = catalog.find(eid)
                    previous = store.get(eid) if (store.get(eid) or {}).get("link") == model.link_key(entry) else None
                    rec = dict(previous or {})
                    rec.update(updates.get(eid) or {})
                    rec["link"] = model.link_key(entry)
                    if eid in pending and install_poster(eid, *pending[eid]):
                        set_poster(rec, pending[eid][0])
                    elif not poster_exists(eid, rec):
                        set_poster(rec, None)
                    store[eid] = rec
    except Exception:
        traceback.print_exc()
    finally:
        for _ext, tmp in pending.values():
            discard(tmp)


def start_restore():
    threading.Thread(target=restore_missing, daemon=True).start()
