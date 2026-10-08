"""Open Library: books, and series (a named grouping of works)."""
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from ..config import OPENLIB_BASE, OPENLIB_COVERS_BASE
from .http import ProviderError, get_json
from .util import join_meta

_WEB = "https://openlibrary.org"
_FIELDS = "key,title,first_publish_year,cover_i,author_name,number_of_pages_median,publish_date"
_DATE_FORMATS = (
    ("%Y-%m-%d", "%Y-%m-%d"),
    ("%B %d, %Y", "%Y-%m-%d"), ("%b %d, %Y", "%Y-%m-%d"),
    ("%d %B %Y", "%Y-%m-%d"), ("%d %b %Y", "%Y-%m-%d"),
    ("%B %Y", "%Y-%m"), ("%b %Y", "%Y-%m"), ("%Y", "%Y"),
)


def _search(params):
    return get_json(f"{OPENLIB_BASE}/search.json?{urllib.parse.urlencode(params)}")


def _cover(cover_i):
    return f"{OPENLIB_COVERS_BASE}/b/id/{cover_i}-M.jpg" if cover_i else None


def _parse_publish_date(text):
    """Free-form edition dates ('March 2, 1961', '2 March 1961', 'March 1961',
    '1961') -> YYYY[-MM[-DD]], consistent with the other sources."""
    t = (text or "").strip()
    if not t:
        return None
    for fmt, out in _DATE_FORMATS:
        try:
            return datetime.strptime(t, fmt).strftime(out)
        except ValueError:
            continue
    return None


def _best_publish_date(doc):
    """The fullest date within the first-publish year, across every edition's
    mixed-format publish_date, falling back to the plain year."""
    year = doc.get("first_publish_year")
    parsed = [p for p in map(_parse_publish_date, doc.get("publish_date") or []) if p]
    if year is not None:
        parsed = [p for p in parsed if p[:4] == str(year)]
    for precision in (10, 7):
        dated = sorted(p for p in parsed if len(p) == precision)
        if dated:
            return dated[0]
    return str(year) if year else None


def _doc_extras(doc):
    """One search doc -> (thumb_url, details); shared by search and lookup so
    the two can't drift apart."""
    authors = doc.get("author_name") or []
    pages = doc.get("number_of_pages_median")
    return _cover(doc.get("cover_i")), {
        "title": doc.get("title"),
        "format": "Book",
        "author": authors[0] if authors else None,
        "start_date": _best_publish_date(doc),
        "pages": pages if isinstance(pages, int) else None,
    }


def search(query):
    payload = _search({"title": query, "limit": "8", "fields": _FIELDS})
    results = []
    for doc in (payload.get("docs") or [])[:8]:
        if not doc.get("title"):
            continue
        key = doc.get("key")
        authors = doc.get("author_name") or []
        thumb, details = _doc_extras(doc)
        results.append({
            "source": "openlibrary",
            "id": str(key or ""),
            "title": doc["title"],
            "meta": join_meta(doc.get("first_publish_year"), authors[0] if authors else None),
            "thumb_url": thumb,
            "url": f"{_WEB}{key}" if key else None,
            "details": details,
        })
    return results


def lookup(key):
    """Work key ('/works/OL45804W' or bare 'OL45804W') -> extras, or None."""
    key = str(key)
    if not key.startswith("/"):
        key = f"/works/{key}"
    docs = _search({"q": f'key:"{key}"', "limit": "1", "fields": _FIELDS}).get("docs") or []
    if not docs:
        return None
    thumb, details = _doc_extras(docs[0])
    return {"url": f"{_WEB}{key}", "thumb_url": thumb, "details": details}


def _fetch_quietly(path):
    try:
        doc = get_json(f"{OPENLIB_BASE}{path}.json")
    except ProviderError:
        return None
    return doc if isinstance(doc, dict) else None


def search_series(query):
    """Search indexes series names but never returns them, so each work and
    then each series is opened (two parallel hops); hence search_on_enter."""
    payload = _search({"q": f'series:"{query}"', "limit": "6", "fields": "key,title"})
    work_keys = [d["key"] for d in (payload.get("docs") or [])[:6] if d.get("key")]
    if not work_keys:
        return []
    with ThreadPoolExecutor(max_workers=6) as ex:
        series_keys = []
        for work in ex.map(_fetch_quietly, work_keys):
            for s in (work or {}).get("series") or []:
                sk = (s.get("series") or {}).get("key") if isinstance(s, dict) else None
                if sk and sk not in series_keys:
                    series_keys.append(sk)
        series_keys = series_keys[:8]
        series_docs = list(zip(series_keys, ex.map(_fetch_quietly, series_keys)))

    results = []
    for series_key, series in series_docs:
        name = (series or {}).get("name")
        if not name:
            continue
        results.append({
            "source": "openlibrary_series",
            "id": series_key,
            "title": name,
            "meta": "Open Library series",
            "thumb_url": None,
            "url": f"{_WEB}{series_key}",
            "details": {"format": "Collection", "title": name},
        })
        if len(results) >= 5:
            break
    return results


def lookup_series(series_key, title=None):
    return {"url": f"{_WEB}{series_key}", "thumb_url": None,
            "details": {"format": "Collection", "title": title} if title else None}


def series_members(title):
    """A series has no queryable id; its NAME is what search indexes."""
    payload = _search({"q": f'series:"{title}"', "limit": "50",
                       "fields": "key,title,first_publish_year,cover_i"})
    members = []
    for doc in payload.get("docs") or []:
        key = doc.get("key")
        if not key:
            continue
        year = doc.get("first_publish_year")
        members.append({
            "ref": key,
            "source": "openlibrary",
            "id": key,
            "kind": "book",
            "title": doc.get("title") or "",
            # Search exposes only a year; bare years still sort correctly
            # against each other as strings.
            "release_date": str(year) if year else None,
            "thumb_url": _cover(doc.get("cover_i")),
            "url": f"{_WEB}{key}",
        })
    return members
