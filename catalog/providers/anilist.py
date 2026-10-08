"""AniList (GraphQL): anime and manga search, details, titles, tracking."""
from datetime import datetime, timezone

from ..config import ANILIST_BASE
from .http import post_json
from .util import is_numeric_id, join_meta

# status(version: 2) is required: the v1 enum lacks HIATUS.
_MEDIA_FIELDS = """
      id
      siteUrl
      title { romaji english }
      startDate { year month day }
      endDate { year month day }
      coverImage { large }
      format
      status(version: 2)
      duration
      episodes
      chapters
      volumes
"""

_SEARCH_QUERY = """
query ($search: String, $type: MediaType, $isAdult: Boolean) {
  Page(perPage: 8) {
    media(search: $search, type: $type, isAdult: $isAdult, sort: SEARCH_MATCH) {%s}
  }
}
""" % _MEDIA_FIELDS

# The "All" source omits isAdult entirely: omitting it returns both SFW and
# adult titles, while passing null would match nothing.
_SEARCH_ALL_QUERY = """
query ($search: String) {
  Page(perPage: 8) {
    media(search: $search, sort: SEARCH_MATCH) {%s}
  }
}
""" % _MEDIA_FIELDS

_BATCH_QUERY = """
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids) {%s}
  }
}
""" % _MEDIA_FIELDS

_TITLES_QUERY = """
query ($id: Int) {
  Media(id: $id) { title { english romaji native } synonyms }
}
"""

_TRACK_QUERY = """
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids) {
      id
      status(version: 2)
      episodes
      chapters
      nextAiringEpisode { episode airingAt }
    }
  }
}
"""


def _query(gql, variables):
    return post_json(ANILIST_BASE, {"query": gql, "variables": variables})


def _page_media(payload):
    return (((payload.get("data") or {}).get("Page") or {}).get("media")) or []


def _title_case(value):
    # Status is stored title-cased ("Finished", "Not Yet Released"); callers
    # compare against that casing.
    return (value or "").replace("_", " ").title() or None


def _date(d):
    if not d or not d.get("year"):
        return None
    y, m, day = d["year"], d.get("month"), d.get("day")
    if m and day:
        return f"{y:04d}-{m:02d}-{day:02d}"
    if m:
        return f"{y:04d}-{m:02d}"
    return str(y)


def _details(item):
    titles = item.get("title") or {}
    return {
        "title": titles.get("english"),
        "title_romaji": titles.get("romaji"),
        "format": _title_case(item.get("format")),
        "status": _title_case(item.get("status")),
        "start_date": _date(item.get("startDate")),
        "end_date": _date(item.get("endDate")),
        "episodes": item.get("episodes"),
        "episode_runtime": item.get("duration"),
        "chapters": item.get("chapters"),
        "volumes": item.get("volumes"),
    }


def search(media_type, query):
    """media_type: 'ANIME' or 'MANGA' (both exclude adult titles), or None
    (All, no adult filter)."""
    if media_type:
        payload = _query(_SEARCH_QUERY, {"search": query, "type": media_type, "isAdult": False})
    else:
        payload = _query(_SEARCH_ALL_QUERY, {"search": query})
    results = []
    for item in _page_media(payload)[:8]:
        titles = item.get("title") or {}
        title = titles.get("english") or titles.get("romaji")
        if not title:
            continue
        details = _details(item)
        year = (item.get("startDate") or {}).get("year")
        results.append({
            "source": "anilist",
            "id": str(item.get("id")),
            "title": title,
            "meta": join_meta(year, details["format"]),
            "thumb_url": (item.get("coverImage") or {}).get("large"),
            "url": item.get("siteUrl"),
            "details": details,
        })
    return results


def _numeric_ids(ids):
    return [int(i) for i in ids if is_numeric_id(i)]


def _batched(ids, gql):
    """Yield every media record for `ids`, one query per 50."""
    ids = _numeric_ids(ids)
    for i in range(0, len(ids), 50):
        yield from _page_media(_query(gql, {"ids": ids[i:i + 50]}))


def lookup_batch(ids):
    """{str_id: {url, thumb_url, details}}."""
    return {str(item.get("id")): {
        "url": item.get("siteUrl"),
        "thumb_url": (item.get("coverImage") or {}).get("large"),
        "details": _details(item),
    } for item in _batched(ids, _BATCH_QUERY)}


def titles(media_id):
    payload = _query(_TITLES_QUERY, {"id": int(media_id)})
    media = (payload.get("data") or {}).get("Media") or {}
    t = media.get("title") or {}
    out, seen = [], set()
    named = [("English", t.get("english")), ("Romaji", t.get("romaji")), ("Native", t.get("native"))]
    named += [("Synonym", s) for s in media.get("synonyms") or []]
    for label, name in named:
        if isinstance(name, str) and name.strip() and name not in seen:
            out.append({"label": label, "title": name.strip()})
            seen.add(name)
    return out


def tracking_batch(ids):
    """{str_id: {status, episodes, chapters, next_ep}}; usually one request
    covers every AniList-linked entry."""
    out = {}
    for m in _batched(ids, _TRACK_QUERY):
        nxt = m.get("nextAiringEpisode") or None
        next_ep = None
        if nxt and isinstance(nxt.get("episode"), int):
            airing_at = nxt.get("airingAt") if isinstance(nxt.get("airingAt"), int) else None
            air = (datetime.fromtimestamp(airing_at, tz=timezone.utc).date().isoformat()
                   if airing_at is not None else None)
            next_ep = {"episode": nxt["episode"], "air_date": air, "airing_at": airing_at}
        out[str(m.get("id"))] = {"status": _title_case(m.get("status")), "episodes": m.get("episodes"),
                                 "chapters": m.get("chapters"), "next_ep": next_ep}
    return out
