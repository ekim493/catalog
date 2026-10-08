"""Comick: the secondary latest-chapter feed for comics."""
import re
import urllib.parse
from datetime import date, timedelta

from ..config import COMICK_BASE
from .http import get_json, pathq
from ..util import parse_iso
from .util import join_meta

_COUNTRY_FORMAT = {"kr": "Manhwa", "cn": "Manhua", "hk": "Manhua"}
_CHAPTER_NUM_RE = re.compile(r"\d+(?:\.\d+)?")
_MAX_GAP_SECONDS = 90 * 86400


def search(query):
    payload = get_json(f"{COMICK_BASE}/v1.0/search?{urllib.parse.urlencode({'q': query, 'limit': 8})}")
    results = []
    for item in payload if isinstance(payload, list) else []:
        title, hid = item.get("title"), item.get("hid")
        if not title or not hid:
            continue
        covers = item.get("md_covers") or []
        cover = None
        if covers and isinstance(covers[0], dict) and covers[0].get("b2key"):
            cover = f"https://meo.comick.pictures/{covers[0]['b2key']}"
        slug = item.get("slug")
        results.append({
            "source": "comick",
            "id": str(hid),
            "title": title,
            "meta": join_meta(item.get("year"),
                              _COUNTRY_FORMAT.get((item.get("country") or "").lower(), "Manga")),
            "thumb_url": cover,
            "url": f"https://comick.io/comic/{slug}" if slug else None,
            "details": None,
        })
    return results


def _parse_chapter_number(text):
    if text is None:
        return None
    nums = _CHAPTER_NUM_RE.findall(str(text))
    if not nums:
        return None
    n = max(float(x) for x in nums)
    return int(n) if n == int(n) else n


def _estimate_next_release(points, source_status):
    """points: [(chapter_number, iso_timestamp)] for distinct chapters ->
    estimated next release date from the MEDIAN gap (outlier-resistant)
    between the last <=8 chapters, ignoring multi-month hiatus gaps. Only
    ongoing series get an estimate."""
    if (source_status or "").lower() not in ("ongoing", "releasing"):
        return None
    pts = sorted((p for p in points if p[1]), key=lambda p: p[0])[-8:]
    if len(pts) < 3:
        return None
    gaps = []
    for prev, cur in zip(pts, pts[1:]):
        d1, d2 = parse_iso(prev[1]), parse_iso(cur[1])
        if d1 and d2 and 0 < (gap := (d2 - d1).total_seconds()) < _MAX_GAP_SECONDS:
            gaps.append(gap)
    base = parse_iso(pts[-1][1])
    if not gaps or not base:
        return None
    gaps.sort()
    return (base + timedelta(seconds=gaps[len(gaps) // 2])).date().isoformat()


def latest(hid, source_status=None):
    """-> (latest_chapter, latest_at YYYY-MM-DD, next_estimate), each may be None."""
    feed = get_json(f"{COMICK_BASE}/comic/{pathq(hid)}/chapters?lang=en&limit=30")
    # {chapter: EARLIEST plausible publish timestamp}, so re-uploads of an old
    # chapter don't skew the cadence estimate.
    max_year = date.today().year + 3
    chapters = {}
    for ch in feed.get("chapters") or []:
        num = _parse_chapter_number(ch.get("chap"))
        if num is None:
            continue
        when = str(ch.get("publish_at") or ch.get("created_at") or "") or None
        year = when[:4] if when else ""
        if not (year.isdigit() and 1990 <= int(year) <= max_year):
            when = None
        if num not in chapters or (when and when < (chapters[num] or "~")):
            chapters[num] = when
    if not chapters:
        return None, None, None
    best = max(chapters)
    best_at = (chapters[best] or "")[:10] or None
    next_est = _estimate_next_release(list(chapters.items()), source_status)
    return (int(best) if float(best) == int(best) else best), best_at, next_est
