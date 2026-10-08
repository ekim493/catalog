"""The entry schema: cleaning, shape rules, and on-disk ordering.

Every write path (create, patch, import) funnels through normalize(), which
removes any field that doesn't belong to the entry's final type, so a type
change or a hand-crafted request can never leave a mismatched field behind."""
import copy
import re
import uuid
from datetime import date, timezone

from . import providers
from .util import is_uuid4, parse_iso, today, utc_now

STATUSES = ("planned", "started", "on_hold", "finished", "dropped")
TERMINAL = {"finished", "dropped"}
STRUCTURAL = {"Show", "Comic"}
MEMBER_SORTS = {"newest", "added", "added_newest", "manual"}

KEY_ORDER = [
    "id", "title", "synonym", "type", "status", "date_added", "date_modified",
    "date_complete", "rating", "notes", "progress", "previous_watches",
    "rewatch_count", "pinned", "hidden", "ignored", "group", "episode_group",
    "specials_watched", "chapter_override", "collection", "always_group",
    "member_sort", "member_order", "cover", "collection_excluded",
    "collection_ratings", "link", "chapter_link",
]
GROUP_ONLY = ("collection", "always_group", "member_sort", "member_order", "cover",
              "collection_excluded", "collection_ratings")
COLLECTION_ONLY = ("collection_excluded", "collection_ratings")
MEMBER_ONLY = ("progress", "previous_watches", "rewatch_count", "pinned", "ignored",
               "group", "episode_group", "specials_watched", "chapter_override", "chapter_link")

MAX_STR = 10000
MAX_REFS = 1000
DETAIL_STR_KEYS = ("title", "title_romaji", "format", "status", "start_date", "end_date",
                   "author", "narrator")
DETAIL_INT_KEYS = ("seasons", "episodes", "episode_runtime", "chapters", "volumes",
                   "runtime", "pages", "collection_id")


class ValidationError(Exception):
    pass


UNSET = object()


# ---------------------------------------------------------------- cleaners

def clean_str(value, limit=MAX_STR):
    return value.strip()[:limit] if isinstance(value, str) else ""


def _clean_id_value(value):
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    return clean_str(value, 200)


def clean_url(value):
    url = clean_str(value, 2000)
    return url if url.startswith(("http://", "https://")) else None


def clean_rating(value):
    if value in (None, ""):
        return None
    try:
        rating = int(value)
    except (TypeError, ValueError, OverflowError):
        raise ValidationError("Rating must be a whole number from 1 to 10")
    if not 1 <= rating <= 10:
        raise ValidationError("Rating must be between 1 and 10")
    return rating


def _number(value, low=0, high=100000):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not low <= value <= high:
        return None
    return int(value) if float(value).is_integer() else float(value)


_SE_RE = re.compile(r"^s\s*(\d+)\s*e\s*(\d+)$", re.I)
_X_RE = re.compile(r"^(\d+)\s*x\s*(\d+)$", re.I)
_EP_RE = re.compile(r"^(?:e|ep|episode)\.?\s*(\d+)$", re.I)
_CH_RE = re.compile(r"^(?:ch|chapter)\.?\s*(\d+(?:\.\d+)?)$", re.I)
_NUM_RE = re.compile(r"^(\d+(?:\.\d+)?)$")


def parse_progress_text(text, entry_type):
    """What people type ("S2E5", "2x5", "Ep 12", "Ch 34", "12") -> a point.
    Only Shows and Comics get structure; anything else stays free text."""
    t = text.strip()[:200]
    if not t:
        return None
    if entry_type in STRUCTURAL:
        m = _SE_RE.match(t) or _X_RE.match(t)
        if m:
            return {"season": int(m.group(1)), "episode": int(m.group(2))}
        m = _EP_RE.match(t)
        if m:
            n = int(m.group(1))
            return {"chapter": n} if entry_type == "Comic" else {"episode": n}
        m = _CH_RE.match(t)
        if m:
            return {"chapter": _number(float(m.group(1)))}
        m = _NUM_RE.match(t)
        if m:
            n = _number(float(m.group(1)))
            return {"chapter": n} if entry_type == "Comic" else {"episode": int(n)}
    return {"text": t}


def progress_text(point):
    if not isinstance(point, dict):
        return ""
    if "season" in point:
        return f"S{point['season']}E{point['episode']}"
    if "episode" in point:
        return f"Ep {point['episode']}"
    if "chapter" in point:
        return f"Ch {point['chapter']}"
    return point.get("text", "")


def clean_progress(value, entry_type):
    if isinstance(value, dict):
        s, e, ch = value.get("season"), value.get("episode"), value.get("chapter")
        if isinstance(s, int) and not isinstance(s, bool) and s >= 1 \
                and isinstance(e, int) and not isinstance(e, bool) and e >= 0:
            point = {"season": s, "episode": e}
        elif "season" not in value and isinstance(e, int) and not isinstance(e, bool) and e >= 0:
            point = {"episode": e}
        elif _number(ch) is not None:
            point = {"chapter": _number(ch)}
        else:
            return parse_progress_text(clean_str(value.get("text")), entry_type)
        # Structure only means something for Shows/Comics, and each has its unit.
        if entry_type == "Comic" and "episode" in point:
            return {"chapter": point["episode"]} if "season" not in point else {"text": progress_text(point)}
        if entry_type == "Show" and "chapter" in point:
            return {"episode": int(point["chapter"])}
        return point if entry_type in STRUCTURAL else {"text": progress_text(point)}
    if isinstance(value, str):
        return parse_progress_text(value, entry_type)
    return None


def clean_points(value, entry_type):
    if not isinstance(value, list):
        return None
    points = [p for p in (clean_progress(v, entry_type) for v in value[:10]) if p]
    return points or None


def clean_entry_ref(value):
    return value if is_uuid4(value) else None


_SOURCE_REF_RE = re.compile(r"^[A-Za-z0-9:/_.-]{1,120}$")


def clean_member_ref(value):
    """A group member reference: an entry id (plain Group) or a source ref
    such as "movie:671" or "/works/OL82563W" (collection)."""
    s = clean_str(value, 200)
    return s if s and _SOURCE_REF_RE.match(s) else None


def clean_ref_list(value):
    if not isinstance(value, list):
        return None
    out = []
    for item in value:
        ref = clean_member_ref(item)
        if ref and ref not in out:
            out.append(ref)
        if len(out) >= MAX_REFS:
            break
    return out or None


def clean_collection_ratings(value):
    if not isinstance(value, dict):
        return None
    out = {}
    for key, raw in list(value.items())[:MAX_REFS]:
        ref = clean_member_ref(key)
        rating = clean_rating(raw)
        if ref and rating is not None:
            out[ref] = rating
    return out or None


_GROUP_ID_RE = re.compile(r"^[a-fA-F0-9]{24}$")
_SPECIAL_RE = re.compile(r"^S(\d+)E(\d+)$")


def clean_episode_group(value):
    s = clean_str(value, 40)
    return s if _GROUP_ID_RE.match(s) else None


def clean_specials(value):
    if not isinstance(value, list):
        return None
    out = []
    for item in value[:2000]:
        s = clean_str(item, 20).upper()
        if _SPECIAL_RE.match(s) and s not in out:
            out.append(s)
    return out or None


def clean_chapter_override(value):
    if value in (None, ""):
        return None
    try:
        n = _number(float(value))
    except (TypeError, ValueError):
        n = None
    if n is None:
        raise ValidationError("Latest-chapter override must be a number from 0 to 100000")
    return n


def clean_rewatch_count(value):
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return n if 0 < n <= 100000 else None


def clean_details(value):
    if not isinstance(value, dict):
        return None
    out = {}
    for k in DETAIL_STR_KEYS:
        v = value.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()[:500]
    for k in DETAIL_INT_KEYS:
        v = value.get(k)
        if isinstance(v, int) and not isinstance(v, bool):
            out[k] = v
    return out or None


def clean_link(value):
    """-> (slim {source,id} or None, extras {url,thumb_url,details}).
    Only the slim identity is canonical; extras go to the details sidecar."""
    if not isinstance(value, dict):
        return None, None
    source = clean_str(value.get("source"), 40)
    link_id = _clean_id_value(value.get("id"))
    if source not in providers.LINK_SOURCES or source in providers.CHAPTER_LINK_SOURCES or not link_id:
        return None, None
    extras = {"url": clean_url(value.get("url")), "thumb_url": clean_url(value.get("thumb_url")),
              "details": clean_details(value.get("details"))}
    return {"source": source, "id": link_id}, extras


def clean_chapter_link(value):
    if not isinstance(value, dict):
        return None
    source = clean_str(value.get("source"), 40)
    link_id = _clean_id_value(value.get("id"))
    if source not in providers.CHAPTER_LINK_SOURCES or not link_id:
        return None
    return {"source": source, "id": link_id,
            "title": clean_str(value.get("title"), 500) or None,
            "url": clean_url(value.get("url"))}


def clean_date_added(value):
    """A bare backfill date stays as-is; a pasted timestamp is normalized to
    whole-second UTC. Unparseable -> None (the caller stamps now)."""
    s = clean_str(value, 60)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s
    dt = parse_iso(s)
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean_local_date(value):
    s = clean_str(value, 20)
    try:
        return date.fromisoformat(s).isoformat() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None
    except ValueError:
        return None


def _flag(value):
    return True if value is True else None


# Fields copied verbatim once cleaned; status, dates and link depend on
# transitions, so create()/apply_patch() handle them.
_SIMPLE = {
    "synonym": lambda v: clean_str(v, 500) or None,
    "notes": lambda v: clean_str(v) or None,
    "rating": clean_rating,
    "rewatch_count": clean_rewatch_count,
    "pinned": _flag, "hidden": _flag, "ignored": _flag,
    "group": clean_entry_ref,
    "episode_group": clean_episode_group,
    "specials_watched": clean_specials,
    "chapter_override": clean_chapter_override,
    "chapter_link": clean_chapter_link,
    "collection": _flag, "always_group": _flag,
    "member_sort": lambda v: v if isinstance(v, str) and v in MEMBER_SORTS else None,
    "member_order": clean_ref_list,
    "cover": clean_member_ref,
    "collection_excluded": clean_ref_list,
    "collection_ratings": clean_collection_ratings,
}
_TYPED = {"progress": clean_progress, "previous_watches": clean_points}


# ---------------------------------------------------------------- shape

def is_group(entry):
    return entry.get("type") == "Group"


def is_collection(entry):
    return is_group(entry) and bool(entry.get("collection"))


def link_key(entry):
    link = entry.get("link")
    if not isinstance(link, dict) or not link.get("source") or not link.get("id"):
        return None
    return f"{link['source']}:{link['id']}"


def tracker_kind(entry):
    source = (entry.get("link") or {}).get("source")
    if entry.get("type") == "Show":
        return {"tmdb_tv": "tmdb_tv", "anilist": "anilist_show"}.get(source)
    if entry.get("type") == "Comic" and source == "anilist":
        return "comic"
    return None


def normalize(entry, now_date=None):
    """Enforce the shape rules for the entry's final type, in place."""
    group = is_group(entry)
    link = entry.get("link")
    if link:
        allowed = providers.GROUP_LINK_SOURCES if group else (
            providers.LINK_SOURCES - providers.GROUP_LINK_SOURCES - providers.CHAPTER_LINK_SOURCES)
        if link.get("source") not in allowed:
            entry["link"] = None

    if group:
        for key in MEMBER_ONLY:
            entry[key] = None
        collection = bool(entry.get("collection")) and bool(entry.get("link"))
        entry["collection"] = True if collection else None
        if collection:
            entry["always_group"] = True
            # Catalog ids belong to plain Groups; collections use source refs.
            if is_uuid4(entry.get("cover")):
                entry["cover"] = None
            order = [r for r in entry.get("member_order") or [] if not is_uuid4(r)]
            entry["member_order"] = order or None
            if entry.get("member_sort") in ("added", "added_newest"):
                entry["member_sort"] = None
            if entry.get("status") not in STATUSES:
                entry["status"] = "finished"
                entry["date_complete"] = now_date or today()
        else:
            entry["status"] = None
            entry["date_complete"] = None
            for key in COLLECTION_ONLY:
                entry[key] = None
            if entry.get("cover") and not is_uuid4(entry["cover"]):
                entry["cover"] = None
            order = [r for r in entry.get("member_order") or [] if is_uuid4(r)]
            entry["member_order"] = order or None
    else:
        for key in GROUP_ONLY:
            entry[key] = None
        etype = entry.get("type")
        if entry.get("status") not in STATUSES:
            entry["status"] = "planned"
        entry["progress"] = clean_progress(entry.get("progress"), etype)
        structural = etype in STRUCTURAL
        if structural:
            entry["rewatch_count"] = None
            entry["previous_watches"] = clean_points(entry.get("previous_watches"), etype)
        else:
            entry["previous_watches"] = None
            entry["pinned"] = None
            entry["ignored"] = None
        if etype != "Comic":
            entry["chapter_override"] = None
            entry["chapter_link"] = None
        if etype != "Show":
            entry["ignored"] = None  # only the Tracker's show menu can ignore
            entry["episode_group"] = None
            entry["specials_watched"] = None

    if entry.get("status") not in TERMINAL:
        entry["date_complete"] = None
    if entry.get("synonym") and entry["synonym"] == entry.get("title"):
        entry["synonym"] = None
    return entry


def ordered(entry):
    """On-disk form: canonical key order, empty optional fields omitted."""
    out = {}
    for key in KEY_ORDER:
        value = entry.get(key)
        if value is None or value is False or value == "" or value == [] or value == {}:
            continue
        if key == "link":
            if not link_key(entry):
                continue
            value = {"source": value["source"], "id": value["id"]}
        elif key == "chapter_link":
            if not isinstance(value, dict):
                continue
            value = {k: value[k] for k in ("source", "id", "title", "url") if value.get(k)}
        out[key] = value
    return out


def prune_references(entries):
    """Membership, cover and manual order must reference real members of the
    right Group. Runs on every write, which also makes deleting a Group a
    plain filter: its former members are released here."""
    plain_groups = {e["id"] for e in entries if is_group(e) and not e.get("collection")}
    members = {}
    for e in entries:
        if e.get("group") and e["group"] not in plain_groups:
            e["group"] = None
        if e.get("group"):
            members.setdefault(e["group"], set()).add(e["id"])
    for e in entries:
        if e["id"] not in plain_groups:
            continue
        own = members.get(e["id"], set())
        if e.get("cover") not in own:
            e["cover"] = None
        order = [m for m in e.get("member_order") or [] if m in own]
        e["member_order"] = order or None


# ---------------------------------------------------------------- writes

def _checked_link(value):
    """null unlinks; anything else must be a valid link."""
    slim, extras = clean_link(value)
    if value is not None and slim is None:
        raise ValidationError("That link isn't a supported source and id")
    return slim, extras


class Change:
    """Result of create()/apply_patch(): the entry, sidecar extras for the
    link (UNSET when the link wasn't part of the request) and, for a plain
    Group, the requested member ids (None = membership untouched)."""

    def __init__(self, entry, extras=UNSET, members=None):
        self.entry = entry
        self.extras = extras
        self.members = members


def _clean_members(value):
    if not isinstance(value, list):
        return None
    return list(dict.fromkeys(m for m in value if is_uuid4(m)))[:MAX_REFS]


def _requested_date(value):
    """Blank means "unknown"; anything else must be a real date."""
    if value in (None, ""):
        return None
    cleaned = clean_local_date(value)
    if cleaned is None:
        raise ValidationError("The completion date must be a real date (YYYY-MM-DD)")
    return cleaned


def _resolve_terminal_date(entry, requested, requested_given, keep_unknown):
    """Completion date after a status/date change. A finished entry may keep
    an explicitly unknown (absent) date; dropped always has one."""
    if entry.get("status") not in TERMINAL:
        return None
    if requested_given:
        if requested:
            return requested
        return None if entry["status"] == "finished" else today()
    if entry.get("date_complete"):
        return entry["date_complete"]
    if entry["status"] == "finished" and keep_unknown:
        return None
    return today()


def create(data, allow_custom_date_added=False):
    title = clean_str(data.get("title"), 1000)
    etype = clean_str(data.get("type"), 40)
    if not title:
        raise ValidationError("Title is required")
    if not etype:
        raise ValidationError("Type is required")
    now = utc_now()
    entry = {"id": str(uuid.uuid4()), "title": title, "type": etype}
    status = data.get("status")
    if status is not None and status not in STATUSES:
        raise ValidationError(f"Status must be one of {', '.join(STATUSES)}")
    entry["status"] = status
    for key, cleaner in _SIMPLE.items():
        if key in data:
            entry[key] = cleaner(data[key])
    for key, cleaner in _TYPED.items():
        if key in data:
            entry[key] = cleaner(data[key], etype)
    entry["link"], extras = _checked_link(data.get("link"))
    if not status and not is_group(entry):
        entry["status"] = "planned"
    date_added = clean_date_added(data.get("date_added")) if allow_custom_date_added and data.get("date_added") else None
    entry["date_added"] = date_added or now
    entry["date_modified"] = now
    entry["date_complete"] = _resolve_terminal_date(
        entry, _requested_date(data.get("date_complete")), "date_complete" in data, keep_unknown=False)
    # Cover and manual order point at members, which only exist once the
    # membership in this same request has been applied (see routes).
    normalize(entry)
    return Change(entry, extras, _clean_members(data.get("members")) if is_group(entry) else None)


def apply_patch(existing, patch):
    entry = copy.deepcopy(existing)
    was_unknown = existing.get("status") == "finished" and not existing.get("date_complete")
    previous_identity = (link_key(existing), existing.get("title"))

    if "title" in patch:
        entry["title"] = clean_str(patch["title"], 1000)
        if not entry["title"]:
            raise ValidationError("Title is required")
    if "type" in patch:
        entry["type"] = clean_str(patch["type"], 40)
        if not entry["type"]:
            raise ValidationError("Type is required")
    etype = entry["type"]
    for key, cleaner in _SIMPLE.items():
        if key in patch:
            entry[key] = cleaner(patch[key])
    for key, cleaner in _TYPED.items():
        if key in patch:
            entry[key] = cleaner(patch[key], etype)

    extras = UNSET
    if "link" in patch:
        entry["link"], extras = _checked_link(patch["link"])

    if is_collection(entry) and previous_identity != (link_key(entry), entry.get("title")):
        # Source refs belong to one collection; a relink or rename can't
        # silently carry the old collection's choices over.
        for key in ("cover", "member_order", "collection_excluded", "collection_ratings"):
            if key not in patch:
                entry[key] = None

    if "status" in patch and (patch["status"] in STATUSES or not is_group(entry)):
        if patch["status"] not in STATUSES:
            raise ValidationError(f"Status must be one of {', '.join(STATUSES)}")
        if patch["status"] != existing.get("status") and patch["status"] not in TERMINAL:
            entry["date_complete"] = None
        entry["status"] = patch["status"]
    entry["date_complete"] = _resolve_terminal_date(
        entry, _requested_date(patch.get("date_complete")), "date_complete" in patch,
        keep_unknown=was_unknown)

    # Undo sends the pre-action timestamp back so the entry looks untouched.
    requested = clean_str(patch.get("date_modified"), 40)
    entry["date_modified"] = requested if parse_iso(requested) else utc_now()
    normalize(entry)
    members = _clean_members(patch.get("members")) if is_group(entry) and "members" in patch else None
    return Change(entry, extras, members)


def from_import(raw):
    """One entry from an export (the exact entries.json format). Ids and
    dates are preserved; an id that isn't a real uuid4 is regenerated because
    ids become poster filenames."""
    if not isinstance(raw, dict):
        return None
    title = clean_str(raw.get("title"), 1000)
    etype = clean_str(raw.get("type"), 40)
    if not title or not etype:
        return None
    entry = {"id": raw["id"] if is_uuid4(raw.get("id")) else str(uuid.uuid4()),
             "title": title, "type": etype,
             "status": raw.get("status") if raw.get("status") in STATUSES else None}
    for key, cleaner in _SIMPLE.items():
        try:
            entry[key] = cleaner(raw.get(key))
        except ValidationError:
            entry[key] = None
    for key, cleaner in _TYPED.items():
        entry[key] = cleaner(raw.get(key), etype)
    entry["link"], _ = clean_link(raw.get("link"))
    now = utc_now()
    entry["date_added"] = clean_str(raw.get("date_added"), 40) or now
    entry["date_modified"] = clean_str(raw.get("date_modified"), 40) or now
    entry["date_complete"] = clean_local_date(raw.get("date_complete"))
    if is_group(entry) and entry.get("collection") and not entry["status"]:
        entry["status"] = "finished"  # with an unknown completion date
    if entry["status"] == "dropped" and not entry["date_complete"]:
        entry["date_complete"] = today()
    return normalize(entry)


def find_recent_duplicate(entries, new, window=5):
    """An accidental double-submit: same title/type/status/link created
    within a few seconds. Measured from server-stamped date_modified because
    date_added may be a deliberately old backfill."""
    title = new["title"].lower()
    for e in entries:
        if (e.get("title", "").lower() == title and e.get("type") == new["type"]
                and e.get("status") == new.get("status") and link_key(e) == link_key(new)):
            when = parse_iso(e.get("date_modified"))
            if when and abs((parse_iso(new["date_modified"]) - when).total_seconds()) <= window:
                return e
    return None
