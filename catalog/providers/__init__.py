"""Upstream metadata providers behind one registry.

Every public function here is the error boundary: failures surface as
ProviderError with a short user-facing message (collection_members() instead
returns None). Adding a provider means a module with the standard result
shape plus registry lines below; nothing else names a provider."""
import copy

from . import anilist, audible, comick, openlibrary, tmdb
from .http import ProviderError, guarded
from .util import TTLCache, is_numeric_id

__all__ = [
    "SEARCH_SOURCES", "TYPE_DEFAULT_SOURCE", "LINK_SOURCE_INFO", "LINK_SOURCES", "GROUP_LINK_SOURCES",
    "CHAPTER_LINK_SOURCES", "CHAPTER_FETCHERS", "COLLECTION_MEMBER_LIMIT",
    "ProviderError", "search", "lookup", "lookup_anilist_batch", "titles",
    "collection_members", "tmdb_tv_tracking", "show_season", "show_structure",
    "tmdb_episode_groups", "remap_points", "anilist_tracking_batch", "comick_latest",
]


def _source(label, backend, arg=None, group=False, secondary=False, search_on_enter=False):
    return {"label": label, "backend": backend, "arg": arg, "group": group,
            "secondary": secondary, "search_on_enter": search_on_enter}


# Search sources (UI dropdown ids), in display order.
SEARCH_SOURCES = {
    "none": _source("None", None),
    "tmdb_tv": _source("TMDb (TV)", "tmdb", "tv"),
    "tmdb_movie": _source("TMDb (Movies)", "tmdb", "movie"),
    "tmdb_all": _source("TMDb (All)", "tmdb", "multi"),
    "anilist_anime": _source("AniList (Anime)", "anilist", "ANIME"),
    "anilist_manga": _source("AniList (Manga)", "anilist", "MANGA"),
    "anilist_all": _source("AniList (All)", "anilist"),
    "openlibrary": _source("OpenLibrary (Books)", "openlibrary"),
    "audible": _source("Audible (Audiobooks)", "audible"),
    "comick": _source("Comick", "comick", secondary=True),
    "tmdb_collection": _source("TMDb (Collections)", "tmdb_collection", group=True),
    "audible_series": _source("Audible (Series)", "audible_series", group=True),
    # Several round-trips per query, so the UI searches it only on Enter.
    "openlibrary_series": _source("OpenLibrary (Series)", "openlibrary_series", group=True,
                                  search_on_enter=True),
}

TYPE_DEFAULT_SOURCE = {
    "Show": "tmdb_tv",
    "Movie": "tmdb_movie",
    "Book": "openlibrary",
    "Comic": "anilist_manga",
    "Audiobook": "audible",
    "Group": "tmdb_collection",
}

# Link namespaces as shown in the UI, which search source re-searches a
# linked entry ("*" = any other type), and whether titles() supports it.
LINK_SOURCE_INFO = {
    "tmdb_tv": {"label": "TMDb", "search": {"*": "tmdb_tv"}, "titles": True},
    "tmdb_movie": {"label": "TMDb", "search": {"*": "tmdb_movie"}, "titles": True},
    "tmdb_collection": {"label": "TMDb", "search": {"*": "tmdb_collection"}},
    "anilist": {"label": "AniList", "search": {"Show": "anilist_anime", "*": "anilist_manga"}, "titles": True},
    "openlibrary": {"label": "Open Library", "search": {"*": "openlibrary"}},
    "openlibrary_series": {"label": "Open Library", "search": {"*": "openlibrary_series"}},
    "audible": {"label": "Audible", "search": {"*": "audible"}},
    "audible_series": {"label": "Audible", "search": {"*": "audible_series"}},
    "comick": {"label": "Comick", "search": {"*": "comick"}},
}

GROUP_LINK_SOURCES = frozenset({"tmdb_collection", "audible_series", "openlibrary_series"})
CHAPTER_LINK_SOURCES = frozenset({"comick"})
LINK_SOURCES = frozenset({"tmdb_tv", "tmdb_movie", "anilist", "openlibrary", "audible"}
                         | GROUP_LINK_SOURCES | CHAPTER_LINK_SOURCES)

COLLECTION_MEMBER_LIMIT = 500

_SEARCH_BACKENDS = {
    "tmdb": tmdb.search,
    "anilist": anilist.search,
    "openlibrary": lambda _arg, q: openlibrary.search(q),
    "audible": lambda _arg, q: audible.search(q),
    "comick": lambda _arg, q: comick.search(q),
    "tmdb_collection": lambda _arg, q: tmdb.search_collections(q),
    "audible_series": lambda _arg, q: audible.search_series(q),
    "openlibrary_series": lambda _arg, q: openlibrary.search_series(q),
}

# Repeated queries (common while typing) skip the upstream round-trip.
_SEARCH_CACHE = TTLCache(3600, 200)


@guarded
def search(source_id, query):
    source = SEARCH_SOURCES.get(source_id)
    query = (query or "").strip()
    if not source or not source["backend"] or not query:
        return []
    key = (source_id, query.lower())
    results = _SEARCH_CACHE.get(key)
    if results is None:
        results = _SEARCH_CACHE.set(key, _SEARCH_BACKENDS[source["backend"]](source["arg"], query))
    # Callers may annotate results; the cached copy must stay pristine.
    return copy.deepcopy(results)


_LOOKUPS = {
    "tmdb_tv": lambda i, _t: tmdb.lookup("tv", i),
    "tmdb_movie": lambda i, _t: tmdb.lookup("movie", i),
    "tmdb_collection": lambda i, _t: tmdb.lookup_collection(i),
    "anilist": lambda i, _t: anilist.lookup_batch([i]).get(str(i)),
    "openlibrary": lambda i, _t: openlibrary.lookup(i),
    "openlibrary_series": openlibrary.lookup_series,
    "audible": lambda i, _t: audible.lookup(i),
    "audible_series": lambda i, _t: audible.lookup_series(i),
}


@guarded
def lookup(source, id, title=None):
    """Full {url, thumb_url, details} for one linked title, or None when the
    source has no lookup or the title wasn't found. `title` is used only by
    openlibrary_series, whose series record has no queryable name."""
    fn = _LOOKUPS.get(source)
    if fn is None or not id:
        return None
    return fn(id, title)


@guarded
def lookup_anilist_batch(ids):
    return anilist.lookup_batch(ids)


@guarded
def titles(source, id):
    media_id = str(id or "").strip()
    if is_numeric_id(media_id):
        if source == "anilist":
            return anilist.titles(media_id)
        if source in ("tmdb_tv", "tmdb_movie"):
            return tmdb.titles(source.removeprefix("tmdb_"), media_id)
    raise ProviderError("Alternate titles are only available for AniList- or TMDb-linked entries")


def collection_members(source, id, title=None, with_details=True):
    """Full source membership of a collection/series, or None when it is
    unavailable (unlinked, unsupported, or the lookup failed). Never raises.

    with_details=False skips round-trips needed only for member titles and
    artwork (Audible's batch product lookup); id matching doesn't need them."""
    if not id:
        return None
    try:
        if source == "tmdb_collection":
            members = tmdb.collection_members(id)
        elif source == "audible_series":
            members = audible.series_members(id, with_details)
        elif source == "openlibrary_series" and title:
            members = openlibrary.series_members(title)
        else:
            return None
    except Exception:  # "no data available" is the contract here
        return None
    return members[:COLLECTION_MEMBER_LIMIT]


tmdb_tv_tracking = guarded(tmdb.tv_tracking)
show_season = guarded(tmdb.show_season)
show_structure = guarded(tmdb.show_structure)
tmdb_episode_groups = guarded(tmdb.episode_groups)
remap_points = guarded(tmdb.remap_points)
anilist_tracking_batch = guarded(anilist.tracking_batch)
comick_latest = guarded(comick.latest)

# Secondary chapter feeds: chapter_link.source -> fetcher(id, source_status)
# returning (latest, latest_at, next_estimate).
CHAPTER_FETCHERS = {"comick": comick_latest}
