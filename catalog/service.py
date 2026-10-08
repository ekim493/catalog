"""Entry mutations. Each one validates first, does any network work (poster
download, collection membership) without the lock, then re-applies the
request to the freshly read entry and commits entry, poster and sidecar in
one locked section — so a concurrent edit during the download isn't lost."""
import traceback

from . import assets, model, storage, tracker
from .storage import catalog, details, lock, tracking
from .web import ApiError


def _response(entry_id):
    entry = catalog.find(entry_id)
    return {"entry": assets.hydrate(entry), "item": tracker.item_for(entry)}


def _index(entries, entry_id):
    idx = next((i for i, e in enumerate(entries) if e["id"] == entry_id), None)
    if idx is None:
        raise ApiError(404, "Entry not found")
    return idx


def _apply_membership(entries, group_id, member_ids):
    """A plain Group's full membership, applied atomically with the group."""
    wanted = set(member_ids)
    for e in entries:
        if model.is_group(e):
            continue
        if e["id"] in wanted:
            e["group"] = group_id
        elif e.get("group") == group_id:
            e["group"] = None


def _commit_assets(entry, extras, poster, members=None):
    """Update the details record and poster to match a committed entry. The
    entry is already saved, so a sidecar failure is logged, never raised."""
    try:
        with details.edit() as records:
            if not entry.get("link"):
                records.pop(entry["id"], None)
                assets.delete_poster(entry["id"])
                return
            old = records.get(entry["id"])
            if old and old.get("link") == model.link_key(entry):
                rec = old
                for key in ("url", "thumb_url", "details"):
                    if (extras or {}).get(key):
                        rec[key] = extras[key]
            else:
                rec = assets.new_record(entry, extras)
            if members is not None:
                assets.set_members(rec, members, entry.get("title"))
            if poster == "delete":
                assets.delete_poster(entry["id"])
                assets.set_poster(rec, None)
            elif poster:
                installed = assets.install_poster(entry["id"], *poster)
                assets.set_poster(rec, poster[0] if installed else None)
            records[entry["id"]] = rec
    except Exception:
        traceback.print_exc()


def create(data, allow_custom_date_added):
    change = model.create(data, allow_custom_date_added)
    entry, extras = change.entry, change.extras or {}
    members = assets.fetch_members(entry) if entry.get("collection") else None
    url = extras.get("thumb_url")
    if entry.get("collection") and entry.get("cover"):
        url = assets.member_thumb(members, entry["cover"]) or url
    poster = assets.download_poster(url) if entry.get("link") and url else (None, None)
    try:
        with lock:
            duplicate = model.find_recent_duplicate(catalog.entries(), entry)
            if duplicate:
                return 200, _response(duplicate["id"])
            with catalog.edit() as entries:
                entries.append(entry)
                if change.members is not None:
                    _apply_membership(entries, entry["id"], change.members)
            if entry.get("link"):
                _commit_assets(catalog.find(entry["id"]), extras, poster if poster[0] else None, members)
    finally:
        assets.discard(poster[1])
    return 201, _response(entry["id"])


def _plan_poster(existing, change, patch):
    """-> (download url or None, fallback action, expected collection identity).
    The fallback ("delete" or None) applies when there's nothing to download
    or the download fails."""
    new, extras = change.entry, change.extras
    relinked = model.link_key(existing) != model.link_key(new)
    url, fallback, expected = None, None, None
    if extras is not model.UNSET or relinked:
        if not new.get("link"):
            return None, "delete", None
        if relinked or not assets.poster_exists(existing["id"], assets.record_for(existing)):
            url = (extras or {}).get("thumb_url") if extras is not model.UNSET else None
            fallback = "delete" if relinked else None
    if new.get("collection") and (relinked or new.get("cover") != existing.get("cover")) \
            and ("cover" in patch or relinked):
        members = None if relinked else assets.cached_members(existing)[0]
        own = (extras or {}).get("thumb_url") if relinked and extras is not model.UNSET \
            else (assets.record_for(existing) or {}).get("thumb_url")
        if new.get("cover"):
            if members is None:
                members = assets.fetch_members(new)
            url = assets.member_thumb(members, new["cover"]) or own
        else:
            url = own
        fallback, expected = "delete", assets.collection_identity(new)
    return url, fallback, expected


def update(entry_id, patch):
    existing = catalog.find(entry_id)
    if existing is None:
        raise ApiError(404, "Entry not found")
    change = model.apply_patch(existing, patch)
    url, fallback, expected = _plan_poster(existing, change, patch)
    members = None
    if change.entry.get("collection") and ((model.link_key(existing), existing.get("title")) !=
                                           (model.link_key(change.entry), change.entry.get("title"))
                                           or assets.cached_members(change.entry)[0] is None):
        members = assets.fetch_members(change.entry)
    downloaded = assets.download_poster(url) if url else (None, None)
    poster = downloaded if downloaded[0] else fallback
    try:
        with lock:
            with catalog.edit() as entries:
                idx = _index(entries, entry_id)
                change = model.apply_patch(entries[idx], patch)
                if expected is not None and assets.collection_identity(change.entry) != expected:
                    raise ApiError(409, "Entry changed while its artwork was loading; save again.")
                entries[idx] = change.entry
                if change.members is not None and not change.entry.get("collection"):
                    _apply_membership(entries, entry_id, change.members)
            committed = catalog.find(entry_id)
            if change.extras is not model.UNSET or poster or members is not None \
                    or model.link_key(existing) != model.link_key(committed):
                _commit_assets(committed, None if change.extras is model.UNSET else change.extras,
                               poster, members)
    finally:
        assets.discard(downloaded[1])
    return _response(entry_id)


def delete(entry_id):
    with lock:
        with catalog.edit() as entries:
            entries.pop(_index(entries, entry_id))
        try:
            with details.edit() as records:
                records.pop(entry_id, None)
            with tracking.edit() as records:
                records.pop(entry_id, None)
        except Exception:
            traceback.print_exc()
        assets.delete_poster(entry_id)
    return {"deleted": entry_id}


def import_entries(raw_entries):
    with lock:
        if catalog.entries():
            raise ApiError(409, "Import is only available while the catalog is empty.")
        imported, seen = [], set()
        for raw in raw_entries:
            entry = model.from_import(raw)
            if entry and entry["id"] not in seen:
                seen.add(entry["id"])
                imported.append(entry)
        if not imported:
            raise ApiError(400, "No usable entries found in that file.")
        catalog.write(imported)
    storage.fresh_start = False
    assets.start_restore()
    return {"imported": len(imported)}
