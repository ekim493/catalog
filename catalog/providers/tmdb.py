"""TMDb: TV shows, movies, collections, seasons and episode groupings."""
from concurrent.futures import ThreadPoolExecutor

from ..config import TMDB_IMAGE_BASE
from .http import pathq, tmdb_get
from ..util import today
from .util import TTLCache, join_meta

_WEB = "https://www.themoviedb.org"
_ENDED = ("Ended", "Canceled")
_EPISODE_GROUP_TYPE_LABELS = {
    1: "Original air date", 2: "Absolute", 3: "DVD", 4: "Digital",
    5: "Story arc", 6: "Production", 7: "TV",
}
_SEASONS = TTLCache(6 * 3600, 100)
# Keyed by group id alone: TMDb's episode-group endpoint takes no show id.
_GROUP_DETAILS = TTLCache(6 * 3600, 50)


def _image(poster_path):
    return f"{TMDB_IMAGE_BASE}/t/p/w185{poster_path}" if poster_path else None


def _web_url(kind, tmdb_id):
    return f"{_WEB}/{kind}/{pathq(tmdb_id)}"


# -- search ------------------------------------------------------------------

def search(kind, query):
    """kind: 'tv', 'movie', or 'multi' (mixed people/tv/movie; only tv and
    movie are kept)."""
    payload = tmdb_get(f"search/{kind}", {"query": query, "include_adult": "false", "page": "1"})
    results = []
    for item in (payload.get("results") or [])[:12]:
        item_kind = item.get("media_type") if kind == "multi" else kind
        if item_kind not in ("tv", "movie"):
            continue
        title = item.get("name") if item_kind == "tv" else item.get("title")
        if not title:
            continue
        release = item.get("first_air_date") if item_kind == "tv" else item.get("release_date")
        tag = ("TV" if item_kind == "tv" else "Movie") if kind == "multi" else None
        results.append({
            "source": f"tmdb_{item_kind}",
            "id": str(item.get("id")),
            "title": title,
            "meta": join_meta((release or "")[:4], tag),
            "thumb_url": _image(item.get("poster_path")),
            "url": _web_url(item_kind, item.get("id")),
            "details": {"title": title, "start_date": release or None},
        })
        if len(results) >= 8:
            break
    return results


def search_collections(query):
    payload = tmdb_get("search/collection", {"query": query, "include_adult": "false", "page": "1"})
    results = []
    for item in (payload.get("results") or [])[:8]:
        name = item.get("name")
        if not name:
            continue
        results.append({
            "source": "tmdb_collection",
            "id": str(item.get("id")),
            "title": name,
            "meta": "TMDb collection",
            "thumb_url": _image(item.get("poster_path")),
            "url": _web_url("collection", item.get("id")),
            "details": {"format": "Collection", "title": name},
        })
    return results


# -- lookups -----------------------------------------------------------------

def _episode_runtime(item):
    """Typical minutes per episode: TMDb's episode_run_time list when it's
    populated, else the most recently aired episode's runtime."""
    runs = [r for r in item.get("episode_run_time") or [] if isinstance(r, int) and r > 0]
    if runs:
        return runs[0]
    last = (item.get("last_episode_to_air") or {}).get("runtime")
    return last if isinstance(last, int) and last > 0 else None


def _tv_details(item):
    status = item.get("status")
    return {
        "title": item.get("name"),
        "format": "TV",
        "status": status,
        "start_date": item.get("first_air_date") or None,
        # last_air_date is just the most recent episode; it is only an end
        # date once the show has actually concluded.
        "end_date": (item.get("last_air_date") or None) if status in _ENDED else None,
        "seasons": item.get("number_of_seasons"),
        "episodes": item.get("number_of_episodes"),
        "episode_runtime": _episode_runtime(item),
    }


def _movie_details(item):
    return {
        "title": item.get("title"),
        "format": "Movie",
        "status": item.get("status"),
        "start_date": item.get("release_date") or None,
        "runtime": item.get("runtime"),
        "collection_id": (item.get("belongs_to_collection") or {}).get("id"),
    }


def lookup(kind, tmdb_id):
    item = tmdb_get(f"{kind}/{pathq(tmdb_id)}")
    return {
        "url": _web_url(kind, tmdb_id),
        "thumb_url": _image(item.get("poster_path")),
        "details": _tv_details(item) if kind == "tv" else _movie_details(item),
    }


def lookup_collection(collection_id):
    item = tmdb_get(f"collection/{pathq(collection_id)}")
    return {
        "url": _web_url("collection", collection_id),
        "thumb_url": _image(item.get("poster_path")),
        "details": {"format": "Collection", "title": item.get("name")},
    }


def titles(kind, tmdb_id):
    item = tmdb_get(f"{kind}/{pathq(tmdb_id)}", {"append_to_response": "alternative_titles"})
    out, seen = [], set()

    def add(label, title):
        t = (title or "").strip()
        if t and t not in seen:
            seen.add(t)
            out.append({"label": label, "title": t})

    alts = item.get("alternative_titles") or {}
    if kind == "tv":
        add("Name", item.get("name"))
        add("Original", item.get("original_name"))
        alts = alts.get("results") or []
    else:
        add("Title", item.get("title"))
        add("Original", item.get("original_title"))
        alts = alts.get("titles") or []
    for a in alts:
        add(a.get("iso_3166_1") or "Alt", a.get("title"))
    return out


def collection_members(collection_id):
    item = tmdb_get(f"collection/{pathq(collection_id)}")
    members = []
    for part in item.get("parts") or []:
        if not part.get("id"):
            continue
        # TV and movie ids share one numeric space, so the kind qualifies the
        # ref and the link source; otherwise an id collision could pull a TV
        # entry into a movie collection.
        kind = part.get("media_type") or "movie"
        pid = str(part["id"])
        members.append({
            "ref": f"{kind}:{pid}",
            "source": "tmdb_tv" if kind == "tv" else "tmdb_movie",
            "id": pid,
            "kind": kind,
            "title": part.get("title") or part.get("name") or "",
            "release_date": part.get("release_date") or part.get("first_air_date") or None,
            "thumb_url": _image(part.get("poster_path")),
            "url": _web_url(kind, pid),
        })
    return members


# -- seasons and episode groupings -------------------------------------------

def episode_groups(tmdb_id):
    """The alternate episode groupings TMDb offers for a show (episode detail
    is a second call, made only for the grouping actually selected)."""
    item = tmdb_get(f"tv/{pathq(tmdb_id)}/episode_groups")
    out = []
    for g in item.get("results") or []:
        if not g.get("id"):
            continue
        out.append({
            "id": g["id"],
            "name": g.get("name") or "Untitled grouping",
            "type_label": _EPISODE_GROUP_TYPE_LABELS.get(g.get("type"), "Custom"),
            "group_count": g.get("group_count"),
            "episode_count": g.get("episode_count"),
            "description": g.get("description") or None,
        })
    return out


def episode_group_detail(group_id):
    key = str(group_id)
    cached = _GROUP_DETAILS.get(key)
    if cached is not None:
        return cached
    return _GROUP_DETAILS.set(key, tmdb_get(f"tv/episode_group/{pathq(group_id)}"))


def season_episodes(tmdb_id, season):
    """One season's episodes in ORIGINAL TMDb numbering (season 0 = specials)."""
    key = (str(tmdb_id), int(season))
    cached = _SEASONS.get(key)
    if cached is not None:
        return cached
    item = tmdb_get(f"tv/{pathq(tmdb_id)}/season/{int(season)}")
    eps = [{"episode": ep["episode_number"], "name": ep.get("name") or None,
            "air_date": ep.get("air_date") or None, "overview": ep.get("overview") or None}
           for ep in item.get("episodes") or []
           if isinstance(ep.get("episode_number"), int)]
    return _SEASONS.set(key, eps)


def _by_order(item):
    # "order" can be present but null, not just absent.
    return item.get("order") or 0


def build_group_structure(detail):
    """One episode-group payload -> numbered display seasons, the specials
    bucket, and last-aired/next-air pointers. A sub-group is the specials
    bucket only when every episode is original season 0, whatever its name."""
    today_date = today()
    seasons, specials = [], []
    for g in sorted(detail.get("groups") or [], key=_by_order):
        eps = sorted((e for e in g.get("episodes") or [] if isinstance(e.get("episode_number"), int)),
                     key=_by_order)
        if not eps:
            continue
        if all((e.get("season_number") or 0) == 0 for e in eps):
            specials.extend({
                "season": e.get("season_number") or 0,
                "episode": e["episode_number"],
                "air_date": e.get("air_date") or None,
                "name": e.get("name") or None,
                "overview": e.get("overview") or None,
            } for e in eps)
            continue
        season_eps = [{
            "episode": i,
            "original_season": e.get("season_number"),
            "original_episode": e["episode_number"],
            "air_date": e.get("air_date") or None,
            "name": e.get("name") or None,
            "overview": e.get("overview") or None,
        } for i, e in enumerate(eps, start=1)]
        seasons.append({"number": len(seasons) + 1, "count": len(season_eps), "episodes": season_eps})

    last_aired = next_air = None
    for s in seasons:
        for ep in s["episodes"]:
            point = {"season": s["number"], "episode": ep["episode"],
                     "air_date": ep["air_date"], "name": ep["name"]}
            if ep["air_date"] and ep["air_date"] <= today_date:
                last_aired = point
            elif next_air is None:
                next_air = point
    return {"seasons": seasons, "specials": specials or None,
            "last_aired": last_aired, "next_air": next_air}


def _air_point(x):
    if not x:
        return None
    return {"season": x.get("season_number"), "episode": x.get("episode_number"),
            "air_date": x.get("air_date") or None, "name": x.get("name") or None}


def _positive_seasons(item):
    return [s for s in item.get("seasons") or []
            if isinstance(s.get("season_number"), int) and s["season_number"] > 0]


def tv_tracking(tmdb_id, episode_group=None):
    item = tmdb_get(f"tv/{pathq(tmdb_id)}")
    tv = _tv_details(item)
    rec = {
        "show_status": item.get("status") or None,
        "in_production": bool(item.get("in_production")),
        "episode_group": episode_group or None,
        # Always from the default /tv payload, even for a grouped show.
        "details": {k: tv[k] for k in ("status", "end_date", "seasons", "episodes", "episode_runtime")},
    }
    if episode_group:
        struct = build_group_structure(episode_group_detail(episode_group))
        rec.update(
            seasons=[s["number"] for s in struct["seasons"]],
            episode_counts={str(s["number"]): s["count"] for s in struct["seasons"]},
            last_aired=struct["last_aired"],
            next_air=struct["next_air"],
            has_specials=bool(struct["specials"]),
        )
        return rec
    positive = _positive_seasons(item)
    rec.update(
        seasons=sorted(s["season_number"] for s in positive),
        # String keys from the start, since this round-trips through JSON.
        episode_counts={str(s["season_number"]): s["episode_count"]
                        for s in positive if isinstance(s.get("episode_count"), int)},
        last_aired=_air_point(item.get("last_episode_to_air")),
        next_air=_air_point(item.get("next_episode_to_air")),
        has_specials=any(s.get("season_number") == 0 and (s.get("episode_count") or 0) > 0
                         for s in item.get("seasons") or []),
    )
    return rec


def show_structure(tmdb_id, group=None):
    rec = tv_tracking(tmdb_id, group)
    counts = rec["episode_counts"]
    return {
        "seasons": [{"number": s, "count": counts.get(str(s))} for s in rec["seasons"]],
        "has_specials": rec["has_specials"],
        "last_aired": rec["last_aired"],
        "next_air": rec["next_air"],
        # Distinguishes "everything that will air has aired" from "nothing
        # scheduled right now" for the picker's bulk-button label.
        "in_production": rec["in_production"],
        "status": rec["show_status"],
    }


def show_season(tmdb_id, season, group=None):
    """Episodes for display season `season` (int >= 1) or "specials", under
    `group` (a TMDb episode-group id) or the plain TMDb seasons.

    Specials carry `ref` = "S{s}E{e}" in ORIGINAL coordinates, which is what
    lets a ticked special survive a grouping switch."""
    is_specials = season == "specials"
    if not is_specials and (not isinstance(season, int) or isinstance(season, bool) or season < 1):
        raise ValueError("season must be an int >= 1 or 'specials'")
    if group:
        # Every season and the specials bucket come from one cached fetch.
        struct = build_group_structure(episode_group_detail(group))
        if is_specials:
            return [{"ref": f"S{sp['season']}E{sp['episode']}", "episode": sp["episode"],
                     "name": sp["name"], "air_date": sp["air_date"], "overview": sp["overview"]}
                    for sp in struct["specials"] or []]
        match = next((s for s in struct["seasons"] if s["number"] == season), None)
        return [{"episode": e["episode"], "name": e["name"], "air_date": e["air_date"],
                 "overview": e["overview"]}
                for e in (match["episodes"] if match else [])]
    if is_specials:
        return [{"ref": f"S0E{e['episode']}", **e} for e in season_episodes(tmdb_id, 0)]
    return [dict(e) for e in season_episodes(tmdb_id, season)]


# -- remapping progress between groupings ------------------------------------

def _flatten(tmdb_id, group_id):
    """Ordered (display_season, display_episode, original_season,
    original_episode, air_date) tuples for one grouping (None = plain seasons).

    Plain seasons need one GET per season (TMDb has no whole-show episode
    list), so they run concurrently."""
    if group_id:
        struct = build_group_structure(episode_group_detail(group_id))
        return [(s["number"], e["episode"], e["original_season"], e["original_episode"], e["air_date"])
                for s in struct["seasons"] for e in s["episodes"]]
    seasons = tv_tracking(tmdb_id)["seasons"]
    if not seasons:
        return []
    with ThreadPoolExecutor(max_workers=4) as ex:
        per_season = list(ex.map(lambda s: (s, season_episodes(tmdb_id, s)), seasons))
    return [(s, ep["episode"], s, ep["episode"], ep.get("air_date"))
            for s, eps in per_season for ep in eps]


def _episode_air_date(tmdb_id, season, episode):
    for ep in season_episodes(tmdb_id, season):
        if ep["episode"] == episode:
            return ep.get("air_date")
    return None


def _remap_point(flat_for, tmdb_id, from_group, to_group, season, episode):
    """Map one point from from_group's numbering to to_group's: the same
    episode, else the latest one airing on or before it. None = unresolved;
    callers keep the raw numbers."""
    if from_group:
        match = next((f for f in flat_for(from_group) if f[0] == season and f[1] == episode), None)
        if not match:
            return None
        orig_s, orig_e, air = match[2], match[3], match[4]
    else:
        orig_s, orig_e, air = season, episode, None

    if to_group:
        exact = next((t for t in flat_for(to_group) if t[2] == orig_s and t[3] == orig_e), None)
        if exact:
            return {"season": exact[0], "episode": exact[1]}
    elif orig_s and orig_s >= 1:
        # Season 0 falls through: linear progress can't point at a special.
        return {"season": orig_s, "episode": orig_e}

    if air is None and not from_group:
        air = _episode_air_date(tmdb_id, orig_s, orig_e)
    if not air:
        return None
    # Ties resolve to the later one in display order.
    best = None
    for t in flat_for(to_group):
        if t[4] and t[4] <= air and (best is None or t[4] >= best[4]):
            best = t
    return {"season": best[0], "episode": best[1]} if best else None


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def remap_points(tmdb_id, from_group, to_group, points):
    if not isinstance(points, list):
        raise ValueError("points must be a list")
    from_group = str(from_group).strip() or None if from_group else None
    to_group = str(to_group).strip() or None if to_group else None
    # Each grouping is flattened at most once per call, and only if needed.
    flat_cache = {}

    def flat_for(gid):
        if gid not in flat_cache:
            flat_cache[gid] = _flatten(tmdb_id, gid)
        return flat_cache[gid]

    return [
        _remap_point(flat_for, tmdb_id, from_group, to_group, p["season"], p["episode"])
        if isinstance(p, dict) and _is_int(p.get("season")) and _is_int(p.get("episode")) else None
        for p in points
    ]
