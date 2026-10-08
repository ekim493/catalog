"""API endpoints. Handlers stay thin; logic lives in service/tracker/stats."""
from datetime import datetime

from . import assets, config, model, providers, service, stash, stats, storage, tracker
from .storage import catalog
from .util import is_uuid4
from .web import MAX_IMPORT_BODY, ApiError, Raw, route

UUID = r"([0-9a-f-]{36})"


def _entry_or_404(entry_id):
    entry = catalog.find(entry_id) if is_uuid4(entry_id) else None
    if entry is None:
        raise ApiError(404, "Entry not found")
    return entry


@route("GET", "/api/config")
def get_config(req):
    return {
        "version": config.APP_VERSION,
        "sources": [{"id": sid, "label": s["label"], "searchable": s["backend"] is not None,
                     "group": s["group"], "secondary": s["secondary"],
                     "search_on_enter": s["search_on_enter"]}
                    for sid, s in providers.SEARCH_SOURCES.items()],
        "type_default_source": providers.TYPE_DEFAULT_SOURCE,
        "link_sources": providers.LINK_SOURCE_INFO,
        "hidden_categories": config.HIDDEN_CATEGORIES,
        "allow_custom_date_added": config.ALLOW_CUSTOM_DATE_ADDED,
        "fresh_start": storage.fresh_start,
    }


# ---------------------------------------------------------------- entries

@route("GET", "/api/entries")
def list_entries(req):
    return assets.hydrate_all(catalog.entries())


@route("POST", "/api/entries")
def create_entry(req):
    return service.create(req.json(), config.ALLOW_CUSTOM_DATE_ADDED)


@route("PATCH", f"/api/entries/{UUID}")
def update_entry(req):
    return service.update(_entry_or_404(req.params[0])["id"], req.json())


@route("DELETE", f"/api/entries/{UUID}")
def delete_entry(req):
    return service.delete(_entry_or_404(req.params[0])["id"])


@route("POST", f"/api/entries/{UUID}/acknowledge")
def acknowledge(req):
    entry = _entry_or_404(req.params[0])
    if not tracker.acknowledge(entry["id"], req.json().get("acknowledged", True) is not False):
        raise ApiError(404, "No tracking record for that entry")
    return {"entry": assets.hydrate(entry), "item": tracker.item_for(entry)}


# ---------------------------------------------------------------- sources

@route("GET", "/api/search")
def search(req):
    query = req.arg("q")
    return {"results": providers.search(req.arg("source"), query) if len(query) >= 2 else []}


@route("GET", "/api/lookup")
def lookup(req):
    record = providers.lookup(req.arg("source"), req.arg("id"), req.arg("title") or None)
    if record is None:
        raise ApiError(404, "No details available for that title")
    return record


@route("GET", "/api/titles")
def titles(req):
    return {"titles": providers.titles(req.arg("source"), req.arg("id"))}


@route("GET", "/api/group/suggestions")
def group_suggestions(req):
    """Catalog entries (not yet in any group) that a linked collection or
    series says belong to it. Takes the raw link so it works before saving."""
    members = providers.collection_members(req.arg("source"), req.arg("id"), req.arg("title"),
                                           with_details=False) or []
    wanted = {(m.get("source"), str(m.get("id"))) for m in members}
    ids = [e["id"] for e in catalog.entries()
           if not model.is_group(e) and not e.get("group") and e.get("link")
           and (e["link"]["source"], e["link"]["id"]) in wanted]
    return {"ids": ids}


UNAVAILABLE = "Couldn't load the collection from its source. Try again later."


@route("GET", "/api/collection")
def collection(req):
    group_id = req.arg("group")
    if not group_id:
        members = providers.collection_members(req.arg("source"), req.arg("id"), req.arg("title"))
        if members is None:
            raise ApiError(502, UNAVAILABLE)
        return {"members": members}
    entry = _entry_or_404(group_id)
    if not entry.get("collection"):
        raise ApiError(404, "Collection not found")
    members, stale = assets.cached_members(entry)
    if members is not None and not stale and req.arg("refresh") != "1":
        return {"members": members}
    identity = assets.collection_identity(entry)
    fresh = assets.fetch_members(entry)
    if fresh is None:
        # Upstream unavailable: stale membership still beats none.
        if members is None:
            raise ApiError(502, UNAVAILABLE)
        return {"members": members}
    assets.save_members(entry["id"], fresh, identity)
    return {"members": fresh}


# ---------------------------------------------------------------- tracker

@route("GET", "/api/tracker")
def tracker_items(req):
    return tracker.payload(tracker.refresh(force=False))


@route("POST", "/api/tracker/refresh")
def tracker_refresh(req):
    return tracker.payload(tracker.refresh(force=True))


def _tmdb_arg(req):
    tmdb_id = req.arg("tmdb")
    if not (tmdb_id.isascii() and tmdb_id.isdigit()):
        raise ApiError(400, "A numeric tmdb id is required")
    return tmdb_id


@route("GET", "/api/show/structure")
def show_structure(req):
    tmdb_id, group = _tmdb_arg(req), req.arg("group") or None
    entry = catalog.find(req.arg("entry")) if req.arg("entry") else None
    if entry and (entry.get("link") or {}).get("id") == tmdb_id and (entry.get("episode_group") or None) == group:
        cached = tracker.cached_structure(entry)
        if cached:
            return cached
    return providers.show_structure(tmdb_id, group)


@route("GET", "/api/show/season")
def show_season(req):
    season = req.arg("season")
    if season != "specials":
        if not (season.isascii() and season.isdigit()) or int(season) < 1:
            raise ApiError(400, "season must be a number or 'specials'")
        season = int(season)
    return {"episodes": providers.show_season(_tmdb_arg(req), season, req.arg("group") or None)}


@route("GET", "/api/show/groups")
def show_groups(req):
    return {"groups": providers.tmdb_episode_groups(_tmdb_arg(req))}


@route("POST", "/api/show/remap")
def show_remap(req):
    data = req.json()
    tmdb_id, points = str(data.get("tmdb") or ""), data.get("points")
    if not (tmdb_id.isascii() and tmdb_id.isdigit()) or not isinstance(points, list):
        raise ApiError(400, "tmdb and points are required")
    return {"points": providers.remap_points(tmdb_id, data.get("from") or None,
                                             data.get("to") or None, points)}


@route("GET", "/api/comic/latest")
def comic_latest(req):
    fetcher = providers.CHAPTER_FETCHERS.get(req.arg("source"))
    if not fetcher or not req.arg("id"):
        raise ApiError(400, "A chapter source and id are required")
    latest, latest_at, _estimate = fetcher(req.arg("id"))
    return {"latest": latest, "latest_at": latest_at}


# ---------------------------------------------------------------- stash

@route("GET", "/api/stash")
def list_stash(req):
    return {"items": stash.listing()}


@route("POST", "/api/stash")
def create_stash_item(req):
    return 201, {"item": stash.create(req.json())}


def _item_or_404(item):
    if item is None:
        raise ApiError(404, "Stashed item not found")
    return {"item": item}


@route("PATCH", f"/api/stash/{UUID}")
def update_stash_item(req):
    return _item_or_404(stash.update(req.params[0], req.json()) if is_uuid4(req.params[0]) else None)


@route("DELETE", f"/api/stash/{UUID}")
def delete_stash_item(req):
    return _item_or_404(stash.delete(req.params[0]) if is_uuid4(req.params[0]) else None)


# ---------------------------------------------------------------- data

@route("GET", "/api/stats")
def get_stats(req):
    return stats.compute(assets.hydrate_all(catalog.entries()), storage.tracking.load(),
                         include_hidden=req.arg("hidden") == "1")


@route("GET", "/api/export")
def export(req):
    catalog.entries()  # refuses a corrupt file
    stamp = datetime.now().strftime("%Y-%m-%d")
    return Raw(catalog.serialized(), "application/json; charset=utf-8",
               {"Content-Disposition": f'attachment; filename="catalog-export-{stamp}.json"'})


@route("POST", "/api/import")
def import_entries(req):
    return service.import_entries(req.json(expect=list, limit=MAX_IMPORT_BODY))
