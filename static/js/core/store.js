// Client state: config, entries, tracker items, and persisted preferences.
// Views subscribe to "entries" / "tracker" and re-render on change.

import { API } from "./api.js";

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) fn(detail);
}

export const state = {
  config: null,
  entries: [],
  byId: new Map(),
  // `edits` maps an item id to the version of its last local update, so a
  // load that started earlier can't overwrite it.
  tracker: { items: [], loaded: false, error: null, promise: null, version: 0, edits: new Map() },
};

export function setConfig(config) {
  state.config = config;
}

export function setEntries(list) {
  state.entries = list;
  state.byId = new Map(list.map((e) => [e.id, e]));
  emit("entries");
}

export function getEntry(id) {
  return state.byId.get(id) || null;
}

function upsertEntry(entry) {
  const i = state.entries.findIndex((e) => e.id === entry.id);
  if (i === -1) state.entries.push(entry);
  else state.entries[i] = entry;
  state.byId.set(entry.id, entry);
  emit("entries");
}

// Mirrors the server's reference pruning so released members are
// immediately usable elsewhere without a reload.
export function removeEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id)
    .map((e) => (e.group === id ? { ...e, group: undefined } : e));
  state.byId = new Map(state.entries.map((e) => [e.id, e]));
  state.tracker.items = state.tracker.items.filter((t) => t.id !== id);
  state.tracker.edits.set(id, ++state.tracker.version);
  emit("entries");
  emit("tracker");
}

function upsertTrackerItem(id, item) {
  state.tracker.edits.set(id, ++state.tracker.version);
  const items = state.tracker.items.filter((t) => t.id !== id);
  if (item) {
    const i = state.tracker.items.findIndex((t) => t.id === id);
    items.splice(i === -1 ? items.length : i, 0, item);
  }
  state.tracker.items = items;
  emit("tracker");
}

// Apply a mutation response ({ entry, item }) everywhere it matters.
export function applyResult(result) {
  if (!result || !result.entry) return result;
  upsertEntry(result.entry);
  if (state.tracker.loaded) {
    upsertTrackerItem(result.entry.id, result.item || null);
    // A newly tracked, relinked or regrouped entry has no fresh record yet;
    // the lazy GET fetches just the stale ones.
    if (result.item && !result.item.fetched_at) loadTracker().catch(() => {});
  }
  return result;
}

export function trackerItem(id) {
  return state.tracker.items.find((t) => t.id === id) || null;
}

// Concurrent callers share one in-flight load.
export function loadTracker({ force = false } = {}) {
  const t = state.tracker;
  if (t.promise) return t.promise;
  t.promise = (async () => {
    emit("tracker-loading", true);
    const since = t.version;
    try {
      const data = force ? await API.refreshTracker() : await API.tracker();
      t.items = mergeTrackerItems(data.items || [], since);
      t.loaded = true;
      t.error = null;
      emit("tracker-updated");
    } catch (err) {
      t.error = err.message;
      throw err;
    } finally {
      t.promise = null;
      emit("tracker-loading", false);
      emit("tracker");
    }
  })();
  return t.promise;
}

// Items updated locally after the load began keep their local version (or
// stay removed); everything else takes the server's.
function mergeTrackerItems(serverItems, since) {
  const t = state.tracker;
  const newer = (id) => (t.edits.get(id) || 0) > since;
  const local = new Map(t.items.map((i) => [i.id, i]));
  const merged = serverItems.filter((i) => !newer(i.id) || local.has(i.id)).map((i) => (newer(i.id) ? local.get(i.id) : i));
  const seen = new Set(merged.map((i) => i.id));
  for (const [id, item] of local) if (newer(id) && !seen.has(id)) merged.push(item);
  for (const [id, v] of t.edits) if (v <= since) t.edits.delete(id);
  return merged;
}

// ---- preferences (localStorage, namespaced) ----

const PREFIX = "catalog4.";

export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (_) { /* private mode */ }
  },
};

// ---- source registry helpers (never hardcode provider names) ----

export function sources() {
  return (state.config && state.config.sources) || [];
}

export function sourceInfo(id) {
  return sources().find((s) => s.id === id) || null;
}

export function sourceLabel(id) {
  const s = sourceInfo(id);
  return s ? s.label : id || "";
}

export function linkLabel(linkSource) {
  const info = ((state.config && state.config.link_sources) || {})[linkSource];
  return info ? info.label : linkSource || "";
}

// The search source that re-searches a linked entry of this type.
export function searchSourceForLink(linkSource, type) {
  const info = ((state.config && state.config.link_sources) || {})[linkSource];
  if (!info) return null;
  return info.search[type] || info.search["*"] || null;
}

export function hasAltTitles(linkSource) {
  return !!(((state.config && state.config.link_sources) || {})[linkSource] || {}).titles;
}

export function defaultSourceFor(type) {
  return ((state.config && state.config.type_default_source) || {})[type] || "none";
}

export function secondarySource() {
  return sources().find((s) => s.secondary) || null;
}

export function hiddenCategories() {
  return new Set((state.config && state.config.hidden_categories) || []);
}

export function isHiddenEntry(entry) {
  return !!entry.hidden || hiddenCategories().has(entry.type);
}
