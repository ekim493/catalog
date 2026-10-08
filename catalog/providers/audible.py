"""Audible's public catalog API (keyless): audiobooks and series."""
import urllib.parse

from ..config import AUDIBLE_BASE
from .http import ProviderError, get_json, pathq
from .util import join_meta

_WEB = "https://www.audible.com"
_GROUPS = "media,contributors,product_attrs"


def _products(**params):
    return get_json(f"{AUDIBLE_BASE}/1.0/catalog/products?{urllib.parse.urlencode(params)}")


def _product(asin, **params):
    query = urllib.parse.urlencode(params)
    return get_json(f"{AUDIBLE_BASE}/1.0/catalog/products/{pathq(asin)}?{query}").get("product") or {}


def _thumb(item):
    images = item.get("product_images") or {}
    return images.get("500") or next(iter(images.values()), None)


def _result(item):
    """One catalog product -> the standard search result, or None."""
    title, asin = item.get("title"), item.get("asin")
    if not title or not asin:
        return None
    authors = [a.get("name") for a in item.get("authors") or [] if a.get("name")]
    narrators = [n.get("name") for n in item.get("narrators") or [] if n.get("name")]
    author = authors[0] if authors else None
    release = (item.get("release_date") or item.get("issue_date") or "")[:10] or None
    runtime = item.get("runtime_length_min")
    return {
        "source": "audible",
        "id": str(asin),
        "title": title,
        "meta": join_meta((release or "")[:4], author),
        "thumb_url": _thumb(item),
        "url": f"{_WEB}/pd/{asin}",
        "details": {
            "title": title,
            "format": "Audiobook",
            "author": author,
            "narrator": ", ".join(narrators) or None,
            "start_date": release,
            "runtime": runtime if isinstance(runtime, int) and runtime > 0 else None,
        },
    }


def search(query):
    payload = _products(keywords=query, num_results="8", products_sort_by="Relevance",
                        response_groups=_GROUPS, image_sizes="500")
    return [r for r in map(_result, payload.get("products") or []) if r]


def lookup(asin):
    r = _result(_product(asin, response_groups=_GROUPS, image_sizes="500"))
    return {"url": r["url"], "thumb_url": r["thumb_url"], "details": r["details"]} if r else None


def search_series(query):
    """There is no series-search endpoint, so series metadata is harvested off
    a normal product search and deduped by series asin. Results can include
    boxed sets and omnibus editions beside the main series; the user picks."""
    payload = _products(keywords=query, num_results="12", products_sort_by="Relevance",
                        response_groups="media,series", image_sizes="500")
    seen = {}
    for item in payload.get("products") or []:
        thumb = _thumb(item)
        for s in item.get("series") or []:
            asin, title = s.get("asin"), s.get("title")
            if not asin or not title or asin in seen:
                continue
            rel_url = s.get("url")
            seen[asin] = {
                "source": "audible_series",
                "id": str(asin),
                "title": title,
                "meta": "Audible series",
                "thumb_url": thumb,
                "url": f"{_WEB}{rel_url}" if rel_url else f"{_WEB}/series/{asin}",
                "details": {"format": "Collection", "title": title},
            }
        if len(seen) >= 8:
            break
    return list(seen.values())


def lookup_series(asin):
    """A series asin is itself a catalog product ("BookSeries"). Series
    products normally carry no cover, so thumb_url is usually None."""
    item = _product(asin, response_groups="media,product_attrs", image_sizes="500")
    title = item.get("title")
    if not title:
        return None
    return {"url": f"{_WEB}/series/{pathq(asin)}", "thumb_url": _thumb(item),
            "details": {"format": "Collection", "title": title}}


def _products_by_asin(asins):
    """{asin: {title, release_date, thumb_url}} for up to 50 asins in one
    request. Best-effort: on failure members just lack artwork and dates."""
    try:
        payload = _products(asins=",".join(asins[:50]), image_sizes="500",
                            response_groups="media,product_desc,product_attrs")
    except ProviderError:
        return {}
    return {item["asin"]: {
        "title": item.get("title"),
        "release_date": item.get("release_date") or item.get("issue_date"),
        "thumb_url": _thumb(item),
    } for item in payload.get("products") or [] if item.get("asin")}


def series_members(asin, with_details=True):
    """Children of a series product. Relationship records carry the asin and
    usually a title but no artwork or date; with_details adds one batch
    product lookup to fill those in."""
    rels = _product(asin, response_groups="relationships").get("relationships") or []
    children = [r for r in rels if r.get("relationship_to_product") == "child" and r.get("asin")]
    extra = _products_by_asin([r["asin"] for r in children]) if with_details and children else {}
    members = []
    for r in children:
        child = r["asin"]
        info = extra.get(child) or {}
        members.append({
            "ref": child,
            "source": "audible",
            "id": child,
            "kind": "audiobook",
            "title": info.get("title") or r.get("title") or child,
            "release_date": info.get("release_date"),
            "thumb_url": info.get("thumb_url"),
            "url": f"{_WEB}/pd/{child}",
        })
    return members
