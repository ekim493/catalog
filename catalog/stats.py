"""Catalog statistics, computed offline from entries + cached data.

Shows/Comics: finished count the source's full total, others count up to
their progress, plus earlier watches. An in-progress show's specials count
only under the default grouping (a custom grouping may fold them in)."""
import re

from . import config, model, tracker

RETURNING = {"Returning Series", "In Production", "Planned", "Pilot", "Releasing",
             "Not Yet Released", "Hiatus"}
KIND_TYPES = {"movie": "Movie", "tv": "Show", "book": "Book", "audiobook": "Audiobook"}


def _stat_entries(entries):
    """Catalog entries plus each collection's included members as virtual
    entries (type from the member kind, rating from the collection)."""
    for e in entries:
        if not model.is_group(e):
            yield e
            continue
        if not e.get("collection"):
            continue
        excluded = set(e.get("collection_excluded") or [])
        ratings = e.get("collection_ratings") or {}
        seen = set()
        for m in e.get("members") or []:
            ref = m.get("ref") if isinstance(m, dict) else None
            if not ref or ref in excluded or ref in seen:
                continue
            seen.add(ref)
            yield {"type": KIND_TYPES.get(m.get("kind"), "Other"), "status": e.get("status"),
                   "rating": ratings.get(ref), "hidden": e.get("hidden"),
                   "date_added": e.get("date_added"), "date_complete": e.get("date_complete")}


def _number(progress):
    if isinstance(progress, dict):
        for key in ("episode", "chapter"):
            if isinstance(progress.get(key), (int, float)):
                return int(progress[key])
        progress = progress.get("text")
    m = re.search(r"\d+", progress) if isinstance(progress, str) else None
    return int(m.group()) if m else None


def episodes_through(progress, rec):
    """Episodes represented by a point, earlier seasons included. Continuous
    numbering (episode beyond its season's count) is already a running total;
    unknown earlier-season counts degrade to the bare episode number."""
    if not (isinstance(progress, dict) and isinstance(progress.get("season"), int)):
        return _number(progress)
    season, episode = progress["season"], progress.get("episode") or 0
    counts = (rec or {}).get("episode_counts") or {}

    def count(s):
        c = counts.get(str(s))
        return c if isinstance(c, int) and c > 0 else None

    if count(season) is not None and episode > count(season):
        return episode
    total = 0
    for s in (rec or {}).get("seasons") or []:
        if s < season:
            if count(s) is None:
                return episode
            total += count(s)
    return total + episode


def compute(entries, tracking_records, include_hidden=False):
    by_type, by_status, ratings = {}, {}, {str(n): 0 for n in range(1, 11)}
    completed, added = {}, {}
    consumed = {"episodes": 0, "chapters": 0, "show_minutes": 0, "movie_minutes": 0,
                "audiobook_minutes": 0, "pages": 0, "movies": 0}
    rated, total, unknown = [], 0, 0
    hidden_types = set(config.HIDDEN_CATEGORIES)

    for e in _stat_entries(entries):
        t = e.get("type") or "Other"
        if not include_hidden and (e.get("hidden") or t in hidden_types):
            continue
        total += 1
        status = e.get("status") or "unknown"
        by_type[t] = by_type.get(t, 0) + 1
        by_status[status] = by_status.get(status, 0) + 1
        if isinstance(e.get("rating"), int):
            rated.append(e["rating"])
            ratings[str(e["rating"])] += 1
        year = (e.get("date_added") or "")[:4]
        if year.isdigit():
            added[year] = added.get(year, 0) + 1
        if status == "finished":
            done = (e.get("date_complete") or "")[:4]
            if done.isdigit():
                completed.setdefault(done, {})
                completed[done][t] = completed[done].get(t, 0) + 1
            else:
                unknown += 1

        d = e.get("details") or {}
        if status == "finished" and t != "Show" and t != "Comic":
            if t == "Movie":
                consumed["movies"] += 1
                if isinstance(d.get("runtime"), int):
                    consumed["movie_minutes"] += d["runtime"]
            elif t == "Audiobook" and isinstance(d.get("runtime"), int):
                consumed["audiobook_minutes"] += d["runtime"]
            elif t == "Book" and isinstance(d.get("pages"), int):
                consumed["pages"] += d["pages"]
        if t not in model.STRUCTURAL:
            continue
        # A finished, ended Show with its progress cleared is deliberately
        # untracked: it stays in the counts above but consumes nothing.
        if t == "Show" and status == "finished" and d.get("status") not in RETURNING and not e.get("progress"):
            continue
        rec = tracking_records.get(e.get("id")) or {}
        if rec.get("identity") != tracker.identity(e, model.tracker_kind(e)):
            rec = {}
        minutes = d.get("episode_runtime") if isinstance(d.get("episode_runtime"), int) else 0

        def add(n):
            if t == "Comic":
                consumed["chapters"] += n
            else:
                consumed["episodes"] += n
                consumed["show_minutes"] += n * minutes

        specials = len(e.get("specials_watched") or []) if t == "Show" else 0
        if status == "finished":
            if t == "Comic":
                full = e.get("chapter_override") or d.get("chapters")
            else:
                full = d.get("episodes")
            if isinstance(full, (int, float)) and full > 0:
                add(int(full))
            add(specials)
        elif status in ("started", "on_hold", "dropped"):
            add(episodes_through(e.get("progress"), rec) or 0)
            if not e.get("episode_group"):
                add(specials)
        for point in e.get("previous_watches") or []:
            add(episodes_through(point, rec) or 0)

    return {
        "total": total, "by_type": by_type, "by_status": by_status,
        "rated_count": len(rated),
        "average_rating": round(sum(rated) / len(rated), 2) if rated else None,
        "ratings": ratings, "consumed": consumed,
        "completed_by_year": completed, "added_by_year": added,
        "unknown_completion": unknown,
    }
