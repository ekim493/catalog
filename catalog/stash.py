"""The Stash: titles spotted somewhere and worth remembering, kept apart from
the catalog until they become planned entries. stash.json is a user-owned
array (newest first) of {id, text, type?, date_added, date_modified}."""
import uuid

from .model import ValidationError, clean_str
from .storage import stash as store
from .util import is_uuid4, parse_iso, utc_now

KEY_ORDER = ("id", "text", "type", "date_added", "date_modified")
MAX_TEXT = 5000


class _Missing(Exception):
    """Raised inside store.edit() so a missing item aborts without a write."""


def _find(records, item_id):
    item = next((r for r in records if isinstance(r, dict) and r.get("id") == item_id), None)
    if item is None:
        raise _Missing()
    return item


def _ordered(item):
    return {k: item[k] for k in KEY_ORDER if item.get(k) not in (None, "")}


def _text(value):
    text = clean_str(value, MAX_TEXT)
    if not text:
        raise ValidationError("Write something first")
    return text


def _commit(records):
    """Newest first, canonical key order. Hand-edited non-objects are kept
    as they are (at the end) rather than dropped."""
    items = [_ordered(r) for r in records if isinstance(r, dict)]
    items.sort(key=lambda r: str(r.get("date_added") or ""), reverse=True)
    records[:] = items + [r for r in records if not isinstance(r, dict)]


def listing():
    return [r for r in store.load()
            if isinstance(r, dict) and isinstance(r.get("id"), str) and isinstance(r.get("text"), str)]


def create(data):
    now = utc_now()
    item = {"id": str(uuid.uuid4()), "text": _text(data.get("text")),
            "type": clean_str(data.get("type"), 40) or None, "date_added": now, "date_modified": now}
    # Undoing a removal sends the item back with its id and dates.
    if data.get("id") is not None:
        if not is_uuid4(data["id"]):
            raise ValidationError("Invalid item id")
        item["id"] = data["id"]
        for key in ("date_added", "date_modified"):
            if parse_iso(data.get(key)):
                item[key] = clean_str(data[key], 40)
    with store.edit() as records:
        if any(isinstance(r, dict) and r.get("id") == item["id"] for r in records):
            raise ValidationError("That item is already in the stash")
        # In front: the sort is stable, so a same-second item still lands first.
        records.insert(0, item)
        _commit(records)
    return _ordered(item)


def update(item_id, data):
    """-> the updated item, or None when it no longer exists."""
    try:
        with store.edit() as records:
            item = _find(records, item_id)
            if "text" in data:
                item["text"] = _text(data["text"])
            if "type" in data:
                item["type"] = clean_str(data["type"], 40) or None
            item["date_modified"] = utc_now()
            _commit(records)
    except _Missing:
        return None
    return _ordered(item)


def delete(item_id):
    """-> the removed item (so the client can offer undo), or None."""
    try:
        with store.edit() as records:
            item = _find(records, item_id)
            records.remove(item)
    except _Missing:
        return None
    return _ordered(item)
