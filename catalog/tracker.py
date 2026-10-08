"""Tracker data: cached release status for followed Shows and Comics.

Records live in tracking.json and refresh lazily (TTL) or on demand. A
refresh also updates the matching details record's release fields from the
same payload, so details don't go stale for anything being tracked."""
import traceback
from concurrent.futures import ThreadPoolExecutor

from . import assets, config, model, providers
from .storage import catalog, details, lock, tracking
from .util import age_seconds, utc_now

TRACKED_STATUSES = {"started", "finished", "on_hold"}
WORKERS = 4


def kind_of(entry):
    kind = model.tracker_kind(entry)
    return kind if kind and entry.get("status") in TRACKED_STATUSES else None


def identity(entry, kind):
    """The upstream link a record describes. A mismatch means the record
    belongs to an earlier link/grouping and must not drive any action."""
    parts = [kind, model.link_key(entry) or ""]
    if kind == "comic":
        cl = entry.get("chapter_link") or {}
        parts.append(f"{cl.get('source', '')}:{cl.get('id', '')}" if cl else "")
    elif kind == "tmdb_tv":
        parts.append(entry.get("episode_group") or "")
    return "|".join(parts)


def _needs_counts(entry, rec):
    """An untracked Show with progress keeps a record for Stats' per-season
    counts; it is fetched once rather than on the tracker's TTL."""
    kind = model.tracker_kind(entry)
    if kind != "tmdb_tv" or kind_of(entry) or not (entry.get("progress") or entry.get("previous_watches")):
        return False
    return not rec or rec.get("identity") != identity(entry, kind)


def _is_stale(rec, entry, kind):
    if not rec or rec.get("identity") != identity(entry, kind) or "fetched_at" not in rec:
        return True
    age = age_seconds(rec.get("fetched_at"))
    return age is None or age > config.TRACK_TTL_HOURS * 3600


def _fetch_tmdb(pairs):
    out = {}

    def work(entry):
        try:
            return entry["id"], providers.tmdb_tv_tracking(entry["link"]["id"], entry.get("episode_group"))
        except Exception:
            return entry["id"], None

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for eid, rec in ex.map(work, [e for e, _ in pairs]):
            if rec:
                rec["kind"] = "tmdb_tv"
                out[eid] = rec
    return out


def _fetch_anilist(pairs):
    out = {}
    try:
        batch = providers.anilist_tracking_batch(sorted({e["link"]["id"] for e, _ in pairs}))
    except Exception:
        return out
    for entry, kind in pairs:
        data = batch.get(entry["link"]["id"])
        if not data:
            continue
        status = data.get("status")
        if kind == "anilist_show":
            total, nxt = data.get("episodes"), data.get("next_ep")
            if nxt:
                last = max(0, nxt["episode"] - 1)
            elif isinstance(total, int) and status in ("Finished", "Cancelled"):
                # A planned total only equals "all aired" once the show has ended.
                last = total
            else:
                last = None
            out[entry["id"]] = {"kind": kind, "show_status": status, "total_episodes": total,
                                "next_ep": nxt, "last_aired_ep": last,
                                "details": {"status": status, "episodes": total}}
        else:
            out[entry["id"]] = {"kind": kind, "source_status": status,
                                "total_chapters": data.get("chapters"),
                                "details": {"status": status, "chapters": data.get("chapters")}}
    return out


def _fetch_chapter_feeds(pairs, results):
    jobs = []
    for entry, _kind in pairs:
        rec = results.get(entry["id"])
        cl = entry.get("chapter_link") or {}
        fetcher = providers.CHAPTER_FETCHERS.get(cl.get("source"))
        if rec is not None and fetcher:
            jobs.append((rec, cl, fetcher))

    def work(job):
        rec, cl, fetcher = job
        try:
            latest, latest_at, estimate = fetcher(cl["id"], rec.get("source_status"))
        except Exception:
            return
        rec.update(alt_source=cl["source"], alt_latest=latest, alt_latest_at=latest_at,
                   alt_next_estimate=estimate)

    if jobs:
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            list(ex.map(work, jobs))


def _refresh_details(records, entries_by_id, results):
    for eid, rec in results.items():
        fresh = rec.pop("details", None) or {}
        entry = entries_by_id.get(eid)
        current = records.get(eid)
        if not entry or not current or current.get("link") != model.link_key(entry):
            continue
        merged = dict(current.get("details") or {})
        for key, value in fresh.items():
            if value is not None:
                merged[key] = value
        # TMDb only reports an end date for a show that has concluded.
        if rec.get("kind") == "tmdb_tv" and not fresh.get("end_date"):
            merged.pop("end_date", None)
        current["details"] = merged


def refresh(force=False):
    """Refresh stale records (all when forced). A failed fetch keeps the old
    record. Returns the current record map."""
    entries = catalog.entries()
    records = tracking.load()
    # Records outlive tracking (Stats reads untracked Shows' season counts);
    # only an entry's deletion or unlinking drops its record.
    keep = {e["id"] for e in entries if model.tracker_kind(e)}
    targets = [(e, k) for e in entries if (k := kind_of(e)) and (force or _is_stale(records.get(e["id"]), e, k))]
    targets += [(e, "tmdb_tv") for e in entries if _needs_counts(e, records.get(e["id"]))]

    if not targets:
        if any(k not in keep for k in records):
            with lock:
                with tracking.edit() as current:
                    for k in [k for k in current if k not in keep]:
                        del current[k]
        return tracking.load()

    results = {}
    if config.TMDB_API_KEY:
        results.update(_fetch_tmdb([p for p in targets if p[1] == "tmdb_tv"]))
    anilist = [p for p in targets if p[1] in ("anilist_show", "comic")]
    if anilist:
        results.update(_fetch_anilist(anilist))
        _fetch_chapter_feeds([p for p in anilist if p[1] == "comic"], results)
    print(f"Tracker refresh: {len(results)}/{len(targets)} records updated")

    identities = {e["id"]: identity(e, k) for e, k in targets}
    with lock:
        by_id = {e["id"]: e for e in catalog.entries()}
        keep = {eid for eid, e in by_id.items() if model.tracker_kind(e)}
        # An entry relinked, regrouped or deleted while the fetch ran must not
        # receive a result that describes its old link.
        results = {eid: rec for eid, rec in results.items()
                   if eid in keep and identity(by_id[eid], model.tracker_kind(by_id[eid])) == identities[eid]}
        try:
            with details.edit() as detail_records:
                _refresh_details(detail_records, by_id, results)
        except Exception:
            traceback.print_exc()
        with tracking.edit() as current:
            for eid, fresh in results.items():
                old = current.get(eid) or {}
                fresh["identity"] = identities[eid]
                fresh["fetched_at"] = utc_now()
                if fresh["kind"] == "comic":
                    # Hiatus -> Releasing is a sticky "back from hiatus" alert
                    # until acknowledged; it never carries across a relink.
                    same = old.get("identity") == fresh["identity"]
                    if same and old.get("source_status") == "Hiatus" and fresh.get("source_status") == "Releasing":
                        fresh["returned_at"], fresh["acknowledged"] = utc_now(), False
                    elif same:
                        fresh["returned_at"] = old.get("returned_at")
                        fresh["acknowledged"] = old.get("acknowledged", False)
                current[eid] = fresh
            for k in [k for k in current if k not in keep]:
                del current[k]
    return tracking.load()


# ---------------------------------------------------------------- payload

def _tuple(p):
    if isinstance(p, dict) and isinstance(p.get("season"), int) and isinstance(p.get("episode"), int):
        return p["season"], p["episode"]
    return None


def _episode(p):
    if isinstance(p, dict) and isinstance(p.get("episode"), int) and "season" not in p:
        return p["episode"]
    t = _tuple(p)
    return t[1] if t else None


def _chapter(p):
    return p["chapter"] if isinstance(p, dict) and isinstance(p.get("chapter"), (int, float)) else None


def _count(counts, season):
    c = counts.get(str(season))
    return c if isinstance(c, int) and c > 0 else None


def season_point(progress, counts, seasons):
    """(season, episode) for a TMDb show. A bare {episode: N} is placed into
    seasons using the per-season counts; None when that can't be done."""
    t = _tuple(progress)
    if t:
        return t
    n = _episode(progress)
    if not n or n <= 0:
        return None
    for s in seasons:
        c = _count(counts, s)
        if c is None:
            return None
        if n <= c:
            return s, n
        n -= c
    return None


def _tmdb_next_quick(pt, last, counts, seasons):
    """The next episode after pt, rolling over season boundaries. Shows with
    continuous numbering (an episode number beyond its season's count, the
    One Piece case) keep counting up while only the season label rolls."""
    if not (pt and last and pt < last):
        return None
    last_count, cur_count = _count(counts, last[0]), _count(counts, pt[0])
    continuous = (last_count is not None and last[1] > last_count) or \
                 (cur_count is not None and pt[1] > cur_count)
    later = [s for s in seasons if s > pt[0]]
    next_season = later[0] if later else pt[0] + 1
    if continuous:
        cumulative = 0
        for s in seasons:
            c = _count(counts, s)
            if c is None:
                cumulative = None
                break
            cumulative += c
            if s == pt[0]:
                break
        season = pt[0] if cumulative is None or pt[1] < cumulative else next_season
        return {"season": min(season, last[0]), "episode": pt[1] + 1}
    if pt[0] != last[0] and cur_count is not None and pt[1] >= cur_count:
        return {"season": next_season, "episode": 1} if next_season <= last[0] else None
    return {"season": pt[0], "episode": pt[1] + 1}


def build_item(entry, rec):
    kind = kind_of(entry)
    if not kind:
        return None
    if not rec or rec.get("identity") != identity(entry, kind):
        rec = {}
    link_rec = assets.record_for(entry) or {}
    item = {
        "id": entry["id"], "title": entry.get("title"), "type": entry.get("type"),
        "status": entry.get("status"), "progress": entry.get("progress"), "kind": kind,
        "fetched_at": rec.get("fetched_at"), "url": link_rec.get("url"),
        "external_id": entry["link"]["id"], "date_modified": entry.get("date_modified"),
        "pinned": bool(entry.get("pinned")), "hidden": bool(entry.get("hidden")),
        "ignored": bool(entry.get("ignored")),
    }
    progress = entry.get("progress")
    if kind == "tmdb_tv":
        la = rec.get("last_aired")
        counts = rec.get("episode_counts") or {}
        seasons = rec.get("seasons") or []
        pt = season_point(progress, counts, seasons)
        last = (la["season"], la["episode"]) if la and la.get("season") is not None else None
        item.update({
            "show_status": rec.get("show_status"), "in_production": rec.get("in_production"),
            "seasons": seasons, "episode_counts": counts, "last_aired": la,
            "next_air": rec.get("next_air"), "episode_group": entry.get("episode_group"),
            "has_specials": rec.get("has_specials"),
            "specials_watched": entry.get("specials_watched") or [],
            "caught_up": bool(pt and pt >= last) if last else None,
            "next_quick": _tmdb_next_quick(pt, last, counts, seasons),
        })
    elif kind == "anilist_show":
        last_ep = rec.get("last_aired_ep")
        ep = _episode(progress)
        item.update({
            "show_status": rec.get("show_status"), "total_episodes": rec.get("total_episodes"),
            "next_ep": rec.get("next_ep"), "last_aired_ep": last_ep,
            "caught_up": bool(ep is not None and ep >= last_ep) if isinstance(last_ep, int) and last_ep > 0 else None,
            "next_quick": {"episode": (ep or 0) + 1} if isinstance(last_ep, int) and (ep or 0) < last_ep else None,
        })
    else:
        # Latest chapter: manual override, then AniList's count (accurate when
        # present), then the secondary feed for ongoing series.
        override = entry.get("chapter_override")
        latest, source, latest_at = None, None, None
        if isinstance(override, (int, float)):
            latest, source = override, "override"
        elif isinstance(rec.get("total_chapters"), int):
            latest, source = rec["total_chapters"], "anilist"
        elif rec.get("alt_latest") is not None:
            latest, source, latest_at = rec["alt_latest"], rec.get("alt_source"), rec.get("alt_latest_at")
        ch = _chapter(progress)
        next_quick = None
        if latest is not None and (ch or 0) < latest:
            # A fractional latest (34.5) has no chapter 35 yet.
            next_quick = {"chapter": min(int(ch or 0) + 1, latest)}
        item.update({
            "source_status": rec.get("source_status"), "total_chapters": rec.get("total_chapters"),
            "latest_chapter": latest, "latest_source": source, "latest_chapter_at": latest_at,
            "next_chapter_estimate": rec.get("alt_next_estimate"),
            "returned": bool(rec.get("returned_at") and not rec.get("acknowledged")),
            "caught_up": bool(ch is not None and ch >= latest) if latest is not None else None,
            "next_quick": next_quick,
        })
    return item


def payload(records=None):
    records = records if records is not None else tracking.load()
    items = [build_item(e, records.get(e["id"])) for e in catalog.entries()]
    return {"items": [i for i in items if i], "generated_at": utc_now()}


def item_for(entry):
    return build_item(entry, tracking.get(entry["id"]))


def acknowledge(entry_id, value):
    with lock:
        with tracking.edit() as records:
            rec = records.get(entry_id)
            if rec is None:
                return False
            rec["acknowledged"] = bool(value)
    return True


def cached_structure(entry):
    """Season structure from a fresh, matching tracking record, else None."""
    kind = kind_of(entry)
    rec = tracking.get(entry["id"]) if kind == "tmdb_tv" else None
    if not rec or _is_stale(rec, entry, kind) or not rec.get("episode_counts"):
        return None
    counts = rec["episode_counts"]
    return {"seasons": [{"number": s, "count": counts.get(str(s))} for s in rec.get("seasons") or []],
            "has_specials": rec.get("has_specials"), "last_aired": rec.get("last_aired"),
            "next_air": rec.get("next_air"), "in_production": rec.get("in_production"),
            "status": rec.get("show_status")}
