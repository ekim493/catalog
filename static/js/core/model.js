// Client-side domain rules: groups, collections, dates, sorting, search.

import { state } from "./store.js";
import { normalizeSearch } from "./format.js";

const TERMINAL = new Set(["finished", "dropped"]);
export const isTerminal = (status) => TERMINAL.has(status);
export const isStructural = (type) => type === "Show" || type === "Comic";
export const isGroup = (e) => !!e && e.type === "Group";
// Statuses the Tracker follows (on hold appears when its filter is on).
export const TRACKED_STATUSES = new Set(["started", "finished", "on_hold"]);
export const isCollection = (e) => isGroup(e) && !!e.collection;

export const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const releaseDate = (e) => ((e && e.details) || {}).start_date || "";
const endDate = (e) => ((e && e.details) || {}).end_date || "";

// Release-status vocabulary shared by the sources (TMDb and AniList).
const ENDED = new Set(["Ended", "Canceled", "Cancelled", "Finished"]);
const AIRING = new Set(["Returning Series", "In Production", "Planned", "Pilot", "Releasing",
  "Not Yet Released", "Hiatus"]);

export function airingState(details) {
  const s = (details || {}).status;
  if (ENDED.has(s)) return "ended";
  if (AIRING.has(s)) return "airing";
  return "unknown";
}

export function releaseStatusTone(status) {
  const s = (status || "").toLowerCase();
  if (/hiatus|paused/.test(s)) return "hiatus";
  if (/returning/.test(s)) return "returning";
  if (/releasing|ongoing|airing|continuing/.test(s)) return "ongoing";
  if (/cancel/.test(s)) return "cancelled";
  if (/finished|ended|released|completed/.test(s)) return "finished";
  if (/not yet|upcoming|planned|production|announced|rumored/.test(s)) return "upcoming";
  return "unknown";
}

// ---- groups ----

export function membersOf(groupId) {
  return state.entries.filter((e) => e.group === groupId);
}

const KIND_TYPES = { movie: "Movie", tv: "Show", book: "Book", audiobook: "Audiobook" };
export const kindType = (kind) => KIND_TYPES[kind] || "Other";

function byRelease(newestFirst, dateOf) {
  return (a, b) => {
    const ra = dateOf(a), rb = dateOf(b);
    if (!ra && !rb) return collator.compare(a.title || "", b.title || "");
    if (!ra) return 1; // undated sinks in both directions
    if (!rb) return -1;
    const cmp = newestFirst ? rb.localeCompare(ra) : ra.localeCompare(rb);
    return cmp || collator.compare(a.title || "", b.title || "");
  };
}

function withManualOrder(list, order, keyOf, fallback) {
  if (!Array.isArray(order) || !order.length) return list.slice().sort(fallback);
  const pos = new Map(order.map((k, i) => [k, i]));
  return list.slice().sort((a, b) => {
    const pa = pos.has(keyOf(a)) ? pos.get(keyOf(a)) : Infinity;
    const pb = pos.has(keyOf(b)) ? pos.get(keyOf(b)) : Infinity;
    return pa !== pb ? pa - pb : fallback(a, b);
  });
}

function memberComparator(sort) {
  if (sort === "newest") return byRelease(true, releaseDate);
  if (sort === "added") return (a, b) => (a.date_added || "").localeCompare(b.date_added || "");
  if (sort === "added_newest") return (a, b) => (b.date_added || "").localeCompare(a.date_added || "");
  return byRelease(false, releaseDate);
}

// Manual order wins; members missing from it follow by the fallback rule.
export function orderedMembers(members, sort, order) {
  const fallback = memberComparator(sort === "manual" ? null : sort);
  return withManualOrder(members, sort === "manual" ? order : null, (e) => e.id, fallback);
}

export function orderedSourceMembers(members, sort, order) {
  const fallback = byRelease(sort === "newest", (m) => m.release_date || "");
  return withManualOrder(members, sort === "manual" ? order : null, (m) => m.ref, fallback);
}

// A collection's included source members, in display order.
export function includedMembers(group) {
  const excluded = new Set(group.collection_excluded || []);
  const list = (group.members || []).filter((m) => m && m.ref && !excluded.has(m.ref));
  return orderedSourceMembers(list, group.member_sort, group.member_order);
}

export function collectionRating(group, ref) {
  const r = (group.collection_ratings || {})[ref];
  return typeof r === "number" ? r : null;
}

const STATUS_PRECEDENCE = ["started", "on_hold", "planned", "finished", "dropped"];

export function groupStatus(group, members) {
  if (group.collection) return group.status || null;
  return STATUS_PRECEDENCE.find((s) => members.some((m) => m.status === s)) || null;
}

// { value, count, own }: a Group's own rating wins over the member average.
export function groupRating(group, members) {
  if (group.rating != null) return { value: group.rating, count: 1, own: true };
  const ratings = group.collection
    ? includedMembers(group).map((m) => collectionRating(group, m.ref)).filter((r) => r != null)
    : members.map((m) => m.rating).filter((r) => r != null);
  if (!ratings.length) return { value: null, count: 0, own: false };
  return { value: Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length), count: ratings.length, own: false };
}

export function memberTypes(group, members) {
  return group.collection ? includedMembers(group).map((m) => kindType(m.kind)) : members.map((m) => m.type);
}

export function posterOf(entry) {
  if (!entry) return null;
  if (isGroup(entry) && !entry.collection && entry.cover) {
    const cover = state.byId.get(entry.cover);
    if (cover && cover.poster) return cover.poster;
  }
  return entry.poster || null;
}

// ---- dates ----

function latestRelease(list, dateOf) {
  return list.reduce((latest, m) => (dateOf(m) > latest ? dateOf(m) : latest), "");
}

function latestMovieRelease(group) {
  return group.collection
    ? latestRelease(includedMembers(group).filter((m) => m.kind === "movie"), (m) => m.release_date || "")
    : latestRelease(membersOf(group.id).filter((e) => e.type === "Movie"), releaseDate);
}

// A finished entry without date_complete has an explicitly unknown date.
// A plain Group inherits that only when every member is such a movie.
export function isUnknownComplete(entry) {
  if (!isGroup(entry) || entry.collection) return entry.status === "finished" && !entry.date_complete;
  const members = membersOf(entry.id);
  return members.length > 0 && members.every((m) => m.type === "Movie" && m.status === "finished" && !m.date_complete);
}

// Unknown completions sort (and display) by the source's end date, then
// its release date.
export function effectiveCompleteDate(entry) {
  if (entry.date_complete) return entry.date_complete;
  if (!isUnknownComplete(entry)) return "";
  return isGroup(entry) ? latestMovieRelease(entry) : endDate(entry) || releaseDate(entry);
}

const DATE_LABELS = { added: "Date added", released: "Date released", ended: "Date ended", complete: "Date completed" };

function dateInfo(value, kind, aggregate = false) {
  return { value: value || "", kind, aggregate, label: DATE_LABELS[kind] };
}

// mode: "relevant" (completed for terminal entries, else added) | "added" | "released"
export function rowDate(entry, mode) {
  if (mode === "released") return dateInfo(releaseDate(entry), "released");
  if (mode !== "added" && isUnknownComplete(entry)) {
    const ended = !isGroup(entry) && endDate(entry);
    if (ended) return dateInfo(ended, "ended");
    return dateInfo(isGroup(entry) ? latestMovieRelease(entry) : releaseDate(entry), "released");
  }
  if (mode !== "added" && isTerminal(entry.status) && entry.date_complete) {
    return dateInfo(entry.date_complete, "complete");
  }
  return dateInfo(entry.date_added, "added");
}

// Dates derived from members are marked aggregate (shown in italics).
export function groupDate(group, members, mode) {
  if (mode === "added") return rowDate(group, mode);
  if (mode === "released") {
    const latest = group.collection
      ? latestRelease(includedMembers(group), (m) => m.release_date || "")
      : latestRelease(members, releaseDate);
    return latest ? dateInfo(latest, "released", true) : rowDate(group, mode);
  }
  if (group.collection) {
    if (isUnknownComplete(group)) {
      const latest = latestMovieRelease(group);
      return dateInfo(latest, "released", !!latest);
    }
    return rowDate(group, mode);
  }
  if (members.length && members.every((m) => isTerminal(m.status))) {
    const dates = members.map((m) => m.date_complete).filter(Boolean);
    if (dates.length) return dateInfo(dates.reduce((a, b) => (b > a ? b : a)), "complete", true);
    if (isUnknownComplete(group)) {
      const latest = latestRelease(members, releaseDate);
      return dateInfo(latest, "released", !!latest);
    }
  }
  return rowDate(group, mode);
}

// ---- sorting ----

const newest = (a, b) => (b || "").localeCompare(a || "");

function compareModified(a, b) {
  return newest(a.date_modified || a.date_added, b.date_modified || b.date_added) || newest(a.date_added, b.date_added);
}

function compareAdded(a, b) {
  return newest(a.date_added, b.date_added);
}

// Undated entries sink to the bottom in BOTH directions.
function datedComparator(dateOf, asc, tiebreak) {
  return (a, b) => {
    const da = dateOf(a), db = dateOf(b);
    if (!da && !db) return tiebreak(a, b);
    if (!da) return 1;
    if (!db) return -1;
    return (asc ? da.localeCompare(db) : db.localeCompare(da)) || tiebreak(a, b);
  };
}

export function comparator(key, dir) {
  const asc = dir === "asc";
  switch (key) {
    case "added": return asc ? (a, b) => compareAdded(b, a) : compareAdded;
    case "complete": return datedComparator(effectiveCompleteDate, asc, compareModified);
    case "released": return datedComparator(releaseDate, asc, compareAdded);
    case "title": return asc ? (a, b) => collator.compare(a.title, b.title) : (a, b) => collator.compare(b.title, a.title);
    case "rating": return (a, b) => (asc ? (a.rating ?? 99) - (b.rating ?? 99) : (b.rating ?? -1) - (a.rating ?? -1)) || compareModified(a, b);
    default: return asc ? (a, b) => compareModified(b, a) : compareModified;
  }
}

// ---- search ----

export function matchesQuery(entry, qn) {
  if (normalizeSearch(entry.title).includes(qn)) return true;
  if (entry.synonym && normalizeSearch(entry.synonym).includes(qn)) return true;
  // A collection's source members aren't entries, so searching one of
  // their titles must surface the collection itself.
  return !!entry.collection && includedMembers(entry).some((m) => normalizeSearch(m.title).includes(qn));
}

