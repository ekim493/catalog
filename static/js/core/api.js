// JSON API client. Every entry mutation resolves to { entry, item }.

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

async function api(path, { method = "GET", body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (_) {
    throw new Error("Couldn't reach the Catalog server.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const API = {
  config: () => api("/api/config"),
  entries: () => api("/api/entries"),
  create: (data) => api("/api/entries", { method: "POST", body: data }),
  update: (id, patch) => api(`/api/entries/${id}`, { method: "PATCH", body: patch }),
  remove: (id) => api(`/api/entries/${id}`, { method: "DELETE" }),
  acknowledge: (id, acknowledged) =>
    api(`/api/entries/${id}/acknowledge`, { method: "POST", body: { acknowledged } }),

  search: (source, q) => api(`/api/search${qs({ source, q })}`),
  lookup: (source, id, title) => api(`/api/lookup${qs({ source, id, title })}`),
  titles: (source, id) => api(`/api/titles${qs({ source, id })}`),
  groupSuggestions: (source, id, title) => api(`/api/group/suggestions${qs({ source, id, title })}`),
  collection: (params) => api(`/api/collection${qs(params)}`),

  tracker: () => api("/api/tracker"),
  refreshTracker: () => api("/api/tracker/refresh", { method: "POST" }),
  showStructure: (tmdb, group, entry) => api(`/api/show/structure${qs({ tmdb, group, entry })}`),
  showSeason: (tmdb, season, group) => api(`/api/show/season${qs({ tmdb, season, group })}`),
  showGroups: (tmdb) => api(`/api/show/groups${qs({ tmdb })}`),
  remap: (tmdb, from, to, points) =>
    api("/api/show/remap", { method: "POST", body: { tmdb, from, to, points } }),
  comicLatest: (source, id) => api(`/api/comic/latest${qs({ source, id })}`),

  stash: () => api("/api/stash"),
  stashItem: (data) => api("/api/stash", { method: "POST", body: data }),
  updateStashItem: (id, patch) => api(`/api/stash/${id}`, { method: "PATCH", body: patch }),
  removeStashItem: (id) => api(`/api/stash/${id}`, { method: "DELETE" }),

  stats: (includeHidden) => api(`/api/stats${includeHidden ? "?hidden=1" : ""}`),
  importEntries: (list) => api("/api/import", { method: "POST", body: list }),
};
