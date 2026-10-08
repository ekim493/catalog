// Tracker view: Shows / Comics / Upcoming, built from GET /api/tracker items.
// Cards never mutate items locally — every action goes through the shared
// actions, which update the store and re-render this view via events.

import { API } from "../core/api.js";
import { clear, h, icon, sequence } from "../core/dom.js";
import { daysFromToday, fmtDateShort, localDate, progressText, relativeDay, statusLabel } from "../core/format.js";
import { TRACKED_STATUSES as TRACKED, collator, posterOf } from "../core/model.js";
import { navigate } from "../core/nav.js";
import {
  getEntry, hiddenCategories, isHiddenEntry, linkLabel, loadTracker, on, prefs, sourceLabel, state, trackerItem,
} from "../core/store.js";
import { confirm, openModal } from "../ui/modal.js";
import { menuButton } from "../ui/menu.js";
import { poster as coverArt } from "../ui/poster.js";
import { toast } from "../ui/toast.js";
import { acknowledge, markProgress, setIgnored, setPinned, setStatus } from "../features/actions.js";
import { fixLatestChapter } from "../features/comic-source.js";
import { openDetails } from "../features/details.js";
import { openEntryForm } from "../features/entry-form.js";
import { pickForItem } from "../features/picker.js";
import { dropdown } from "../ui/dropdown.js";

const TABS = [
  { id: "shows", label: "Shows" },
  { id: "comics", label: "Comics" },
  { id: "upcoming", label: "Upcoming" },
];
const SORTS = ["modified", "watched", "released", "title"];
const FLASH_MS = 2000;

const storedTab = prefs.get("tracker.tab", "shows");
const storedSort = prefs.get("tracker.sort", "modified");
const storedCollapsed = prefs.get("tracker.collapsed", []);

const view = {
  tab: TABS.some((t) => t.id === storedTab) ? storedTab : "shows",
  sort: SORTS.includes(storedSort) ? storedSort : "modified",
  showOnHold: !!prefs.get("tracker.onHold", false),
  showHidden: !!prefs.get("tracker.hidden", false),
  collapsed: new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []),
  loading: false,
  flashId: null,
};

let root = null;
const els = {};
const focusSeq = sequence();
let flashTimer = null;
let renderQueued = false;
let hiddenTypes = new Set();

export function showInTracker(entryId) {
  navigate("tracker", { focus: entryId });
}

// Whether the entry has a card on the Tracker, so "Show in tracker" lands.
// On hold counts: jumping to one turns the On hold filter on.
export function inTracker(entry) {
  if (!entry.tracker_kind || !TRACKED.has(entry.status) || entry.ignored) return false;
  if (isHiddenEntry(entry) && !view.showHidden) return false;
  if (entry.status !== "finished") return true;
  const t = trackerItem(entry.id);
  if (!t) return false;
  return t.kind === "comic" ? !!t.returned : !!t.pinned || returningShow(t);
}

// ---------------------------------------------------------------- lifecycle

export function mount(section) {
  root = section;
  els.subtitle = h("p", { class: "view-subtitle" });
  els.refresh = h("button", { type: "button", class: "btn btn-ghost", onClick: refresh },
    icon("refresh", 16), "Refresh data");
  els.tabs = h("div", { class: "segmented tracker-tabs", role: "tablist" },
    TABS.map((t) => h("button", { type: "button", role: "tab", dataset: { tab: t.id },
      onClick: () => setTab(t.id) }, t.label)));
  els.onHold = h("input", { type: "checkbox", checked: view.showOnHold, onChange: () => {
    view.showOnHold = els.onHold.checked;
    prefs.set("tracker.onHold", view.showOnHold);
    render();
  } });
  els.hidden = h("input", { type: "checkbox", checked: view.showHidden, onChange: onHiddenToggle });
  els.sort = h("select", { class: "select tracker-sort", "aria-label": "Sort", onChange: () => {
    view.sort = els.sort.value;
    prefs.set("tracker.sort", view.sort);
    render();
  } }, SORTS.map((value) => h("option", { value })));
  els.list = h("div", { class: "tracker-body" });

  clear(section,
    h("header", { class: "view-header" },
      h("div", null, h("h1", { class: "view-title" }, "Tracker"), els.subtitle),
      h("div", { class: "view-actions" }, els.refresh)),
    h("div", { class: "tracker-toolbar" }, els.tabs,
      h("div", { class: "tracker-filters" },
        h("label", { class: "check" }, els.onHold, "On hold"),
        h("label", { class: "check" }, els.hidden, "Hidden"),
        dropdown(els.sort))),
    els.list);

  view.loading = !!state.tracker.promise;
  on("tracker", scheduleRender);
  on("entries", scheduleRender);
  on("tracker-loading", (flag) => {
    view.loading = !!flag;
    scheduleRender();
  });
}

export async function activate(params = {}) {
  const focus = params.focus || null;
  if (focus) {
    // A later re-render or reload must not re-jump to this card.
    history.replaceState(null, "", `${location.pathname}${location.search}#/tracker`);
    const entry = getEntry(focus);
    setTab(entry && entry.type === "Comic" ? "comics" : "shows", { silent: true });
    if (entry && entry.status === "on_hold" && !view.showOnHold) {
      view.showOnHold = true;
      prefs.set("tracker.onHold", true);
    }
  }
  // Always revalidate: the server answers from its cache and only fetches
  // records that are stale (TTL, new links, changed groupings).
  const load = loadTracker().catch(() => {});
  render();
  const token = focusSeq.next(); // a newer navigation cancels a pending jump
  if (!focus) return;
  await load;
  if (!focusSeq.isCurrent(token) || root.hidden) return;
  render();
  jumpTo(focus);
}

function isVisible() {
  return !!root && !root.hidden;
}

// Coalesces the "entries" + "tracker" pair a single mutation emits.
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
}

function setTab(id, { silent = false } = {}) {
  if (view.tab === id) return;
  view.tab = id;
  prefs.set("tracker.tab", id);
  if (!silent) render();
}

async function onHiddenToggle() {
  if (els.hidden.checked) {
    els.hidden.checked = false; // only set once confirmed
    const ok = await confirm({
      title: "Show hidden entries?",
      message: "Hidden entries and entries from hidden categories will appear in the Tracker until this is unchecked.",
      confirmLabel: "Show them",
    });
    if (!ok) return;
    els.hidden.checked = true;
  }
  view.showHidden = els.hidden.checked;
  prefs.set("tracker.hidden", view.showHidden);
  render();
}

async function refresh() {
  try {
    await loadTracker({ force: true });
    toast("Tracking data refreshed.");
  } catch (err) {
    toast(`Couldn't refresh tracking data: ${err.message}`);
  }
}

function jumpTo(id) {
  const find = () => els.list.querySelector(`.tracker-card[data-id="${CSS.escape(id)}"]`);
  let card = find();
  if (!card) {
    toast("This entry isn't visible in the Tracker — it may be ignored, hidden, or no longer trackable.");
    return;
  }
  const key = card.closest(".tracker-section")?.dataset.section;
  if (key && view.collapsed.has(key)) {
    view.collapsed.delete(key);
    prefs.set("tracker.collapsed", [...view.collapsed]);
    render();
    card = find();
  }
  // Remembered so a re-render during the flash keeps the highlight.
  view.flashId = id;
  card.classList.add("tracker-flash");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    view.flashId = null;
    for (const el of els.list.querySelectorAll(".tracker-flash")) el.classList.remove("tracker-flash");
  }, FLASH_MS);
  card.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------------------------------------------------------------- render

function render() {
  if (!isVisible()) return;
  syncChrome();
  const t = state.tracker;
  if (!t.loaded) {
    clear(els.list, t.error && !view.loading ? errorState(t.error) : h("div", { class: "loading" }, "Checking statuses…"));
    return;
  }
  hiddenTypes = hiddenCategories();
  const base = t.items.filter((item) => !item.ignored &&
    (view.showHidden || (!item.hidden && !hiddenTypes.has(item.type))));
  if (view.tab === "upcoming") clear(els.list, renderUpcoming(base));
  else if (view.tab === "comics") clear(els.list, renderComics(base));
  else clear(els.list, renderShows(base));
}

function syncChrome() {
  for (const btn of els.tabs.children) {
    const active = btn.dataset.tab === view.tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  const comics = view.tab === "comics";
  const labels = {
    modified: "Recently modified",
    watched: comics ? "Recently read" : "Recently watched",
    released: comics ? "Newest chapter" : "Newest episode",
    title: "Title (A–Z)",
  };
  for (const opt of els.sort.options) opt.textContent = labels[opt.value];
  els.sort.value = view.sort;
  els.sort.hidden = view.tab === "upcoming"; // the schedule is always chronological
  els.onHold.checked = view.showOnHold;
  els.hidden.checked = view.showHidden;
  els.refresh.disabled = view.loading;
  els.subtitle.textContent = subtitleText();
  els.subtitle.hidden = !els.subtitle.textContent;
}

function subtitleText() {
  if (view.loading) return state.tracker.loaded ? "Refreshing…" : "Checking statuses…";
  // The oldest record bounds how stale anything on screen can be.
  const times = state.tracker.items.map((i) => Date.parse(i.fetched_at)).filter((n) => !isNaN(n));
  if (!times.length) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Math.min(...times)) / 60000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Updated ${hours}h ago` : `Updated ${Math.round(hours / 24)}d ago`;
}

function errorState(message) {
  return h("div", { class: "empty" },
    h("div", { class: "empty-title" }, "Couldn't load tracking data"),
    h("div", null, message),
    h("div", { class: "empty-action" }, h("button", { type: "button", class: "btn btn-sm",
      onClick: () => loadTracker().catch(() => {}) }, "Retry")));
}

function emptyState(text) {
  return h("div", { class: "empty tracker-empty" }, text);
}

const onHoldVisible = (t) => t.status !== "on_hold" || view.showOnHold;

function section(id, heading, items, build) {
  if (!items.length) return null;
  const key = `${view.tab}:${id}`;
  const collapsed = view.collapsed.has(key);
  const cards = h("div", { class: "tracker-cards", hidden: collapsed }, sortItems(items).map(build));
  const toggle = h("button", { type: "button", class: "section-heading tracker-section-toggle",
    "aria-expanded": String(!collapsed), onClick: () => {
      const closed = !view.collapsed.has(key);
      if (closed) view.collapsed.add(key);
      else view.collapsed.delete(key);
      prefs.set("tracker.collapsed", [...view.collapsed]);
      cards.hidden = closed;
      toggle.setAttribute("aria-expanded", String(!closed));
    } }, icon("chevronDown", 14), h("span", null, heading), h("span", { class: "count" }, items.length));
  return h("section", { class: "tracker-section", dataset: { section: key } }, toggle, cards);
}

// ---------------------------------------------------------------- sorting

function lastReleaseDate(t) {
  if (t.kind === "tmdb_tv") return (t.last_aired && t.last_aired.air_date) || "";
  if (t.kind === "comic") return t.latest_chapter_at || "";
  return ""; // AniList doesn't expose the last air date
}

const byModified = (a, b) => (b.date_modified || "").localeCompare(a.date_modified || "");

function sortItems(list) {
  const out = list.slice();
  if (view.sort === "title") return out.sort((a, b) => collator.compare(a.title || "", b.title || ""));
  if (view.sort === "released") {
    // Undated items (AniList shows) follow the dated ones.
    return out.sort((a, b) => {
      const la = lastReleaseDate(a), lb = lastReleaseDate(b);
      if (la !== lb) {
        if (!la) return 1;
        if (!lb) return -1;
        return lb.localeCompare(la);
      }
      return byModified(a, b);
    });
  }
  if (view.sort === "watched") {
    // Entries with no progress logged sink within each section.
    return out.sort((a, b) => (b.progress ? 1 : 0) - (a.progress ? 1 : 0) || byModified(a, b));
  }
  return out.sort(byModified);
}

// ---------------------------------------------------------------- cards

function tag(text, variant) {
  return h("span", { class: ["tag", variant && `tag-${variant}`] }, text);
}

function cardTags(t) {
  return [
    t.caught_up ? tag("Caught up", "blue") : null,
    t.status === "on_hold" ? tag("On hold", "amber") : null,
  ];
}

const poster = (entry, item, className) => coverArt(posterOf(entry), { type: item.type, className });

function titleEl(item, entry) {
  if (!entry) return h("span", { class: "tracker-title" }, item.title);
  return h("button", { type: "button", class: "tracker-title", title: "Show details",
    onClick: () => openDetails(getEntry(item.id) || entry) }, item.title);
}

function aliasEl(entry) {
  return entry && entry.synonym ? h("div", { class: "tracker-sub" }, entry.synonym) : null;
}

function primaryButton(p) {
  const btn = h("button", { type: "button", class: ["btn", "btn-sm", "tracker-primary", p.ghost ? "btn-ghost" : "btn-primary"],
    title: p.title, onClick: p.onClick }, p.icon ? icon(p.icon, 14) : null, p.label);
  if (!p.onInfo) return btn;
  return h("div", { class: "tracker-primary-wrap" }, btn,
    h("button", { type: "button", class: "tracker-info-btn", title: p.infoTitle, "aria-label": p.infoTitle,
      onClick: p.onInfo }, "i"));
}

function card(item, { tags = [], lines = [], primary, menu }) {
  const entry = getEntry(item.id);
  const hidden = item.hidden || hiddenTypes.has(item.type);
  const allTags = [...tags, hidden ? tag("Hidden") : null].filter(Boolean);
  return h("article", { class: ["card", "tracker-card", view.flashId === item.id && "tracker-flash"],
    dataset: { id: item.id } },
    poster(entry, item, "tracker-poster"),
    h("div", { class: "tracker-card-body" },
      titleEl(item, entry),
      aliasEl(entry),
      allTags.length ? h("div", { class: "tracker-tags" }, allTags) : null,
      lines.filter(Boolean).map((line) => h("div", { class: "tracker-line" }, line))),
    h("div", { class: "tracker-card-actions" },
      primaryButton(primary),
      menuButton(menu, { label: "More" })));
}

// ---------------------------------------------------------------- actions

// Resolves the entry at click time so an action never works on a stale copy.
function act(item, fn) {
  return () => {
    const entry = getEntry(item.id);
    if (entry) fn(entry);
  };
}

function pinItem(t) {
  const pinned = !!t.pinned;
  return { label: pinned ? "Unpin" : "Pin",
    title: pinned ? "Remove from the Pinned section" : "Pin to the top of the Tracker",
    onClick: act(t, (e) => setPinned(e, !pinned)) };
}

function holdItem(t) {
  return { label: "Put on hold", title: "Put this on hold",
    onClick: act(t, (e) => setStatus(e, "on_hold", { message: "Put on hold." })) };
}

function dropItem(t) {
  return { label: "Drop series", title: "Move this to dropped",
    onClick: act(t, (e) => setStatus(e, "dropped", { message: "Dropped." })) };
}

function ignoreItem(t) {
  return { label: "Ignore", title: "Hide this show from the Tracker",
    onClick: act(t, (e) => setIgnored(e, true)) };
}

function editItem(t) {
  return { label: "Edit entry", title: "Open the full edit form", onClick: act(t, (e) => openEntryForm(e)) };
}

function fixLatestItem(t) {
  return { label: "Fix latest chapter", title: "Override the latest-chapter number",
    onClick: act(t, (e) => fixLatestChapter(e, t)) };
}

// The finale of the latest fully aired season.
function lastCompleteSeason(t) {
  const la = t.last_aired;
  const count = (s) => {
    const c = (t.episode_counts || {})[String(s)];
    return Number.isInteger(c) && c > 0 ? c : null;
  };
  // TMDb may not list a running season's later episodes yet, so a due next
  // episode also counts. Continuous numbering has no finale to fall back to.
  const current = count(la.season);
  const continuous = current != null && la.episode > current;
  const midRun = (t.next_air && t.next_air.season === la.season) || (current != null && la.episode < current);
  if (continuous || !midRun) return { season: la.season, episode: la.episode };
  const previous = (t.seasons || []).filter((s) => s > 0 && s < la.season).pop();
  const end = previous != null ? count(previous) : null;
  return end ? { season: previous, episode: end } : null;
}

// A finished show may never have had progress tracked; without a completed
// season the saved progress stays.
function watchAgainButton(t) {
  let progress = null;
  if (t.kind === "tmdb_tv" && t.last_aired && t.last_aired.season != null) {
    progress = lastCompleteSeason(t);
  } else if (t.kind === "anilist_show" && typeof t.last_aired_ep === "number" && t.last_aired_ep > 0) {
    progress = { episode: t.last_aired_ep };
  }
  return { label: "Watch again",
    title: progress ? `Move back to started, up to ${progressText(progress)}` : "Move back to started",
    onClick: act(t, (e) => setStatus(e, "started", { progress, message: "Moved to started." })) };
}

// Every card's menu keeps one order: Set…, Pin, (Fix latest chapter),
// Finished, Put on hold, Drop, (Ignore), Edit, info lines.
// Shows and Comics share this branching and differ only through cfg.
function trackerActions(t, cfg) {
  const menu = [];
  const afterPin = cfg.afterPin ? cfg.afterPin(t) : [];
  const finish = { label: cfg.finishedLabel,
    title: t.caught_up ? `You're caught up — move this ${cfg.noun} to finished` : `Move this ${cfg.noun} to finished`,
    onClick: act(t, (e) => setStatus(e, "finished", { message: "Marked as finished." })) };
  const set = { label: cfg.setLabel, title: cfg.setTitle, onClick: () => pickForItem(t) };
  let primary;
  if (t.status === "on_hold") {
    primary = { label: "Resume", title: "Move back to started",
      onClick: act(t, (e) => setStatus(e, "started", { message: "Resumed." })) };
    menu.push(set, pinItem(t), ...afterPin, finish, dropItem(t));
  } else if (t.caught_up) {
    primary = finish;
    menu.push(set, pinItem(t), ...afterPin, holdItem(t), dropItem(t));
  } else {
    if (t.next_quick) {
      const point = t.next_quick;
      const label = progressText(point);
      primary = { label, icon: "check", title: cfg.nextTitle,
        onClick: act(t, (e) => markProgress(e, point, `Marked ${label} ${cfg.nextVerb}.`)),
        onInfo: t.kind === "tmdb_tv" && point.season != null ? () => openEpisodeInfo(t, point) : null,
        infoTitle: `Show info for ${label}` };
      menu.push(set);
    } else {
      primary = { ...set, ghost: true };
    }
    menu.push(pinItem(t), ...afterPin, finish, holdItem(t), dropItem(t));
  }
  if (cfg.beforeEdit) menu.push(...cfg.beforeEdit(t));
  menu.push(editItem(t));
  const behind = behindCount(t);
  if (behind) menu.push({ info: `${behind} ${cfg.unit}${behind === 1 ? "" : "s"} to catch up` });
  for (const info of cfg.trailingInfo(t)) if (info) menu.push({ info });
  return { primary, menu };
}

// Episodes/chapters between progress and the latest release. Handles
// per-season and continuous (One Piece) numbering via the season counts.
function behindCount(t) {
  const p = t.progress || {};
  if (t.kind === "tmdb_tv") {
    const la = t.last_aired;
    if (!la || la.season == null) return null;
    const counts = t.episode_counts || {};
    const seasons = t.seasons || [];
    const cnt = (s) => {
      const c = counts[String(s)];
      return typeof c === "number" && c > 0 ? c : null;
    };
    const continuous = cnt(la.season) != null && la.episode > cnt(la.season);
    const absIndex = (s, e) => {
      if (continuous) return e;
      let total = 0;
      for (const x of seasons) {
        if (x >= s) break;
        const c = cnt(x);
        if (c == null) return null;
        total += c;
      }
      return total + e;
    };
    const latest = absIndex(la.season, la.episode);
    if (latest == null) return null;
    let current = 0;
    if (p.season != null && p.episode != null) {
      current = absIndex(p.season, p.episode);
      if (current == null) return null;
    } else if (p.episode != null) {
      current = p.episode;
    }
    return Math.max(0, latest - current);
  }
  if (t.kind === "anilist_show") {
    if (t.last_aired_ep == null) return null;
    return Math.max(0, t.last_aired_ep - (p.episode || 0));
  }
  if (t.latest_chapter == null) return null;
  return Math.max(0, Math.ceil(t.latest_chapter - (p.chapter || 0)));
}

// ---------------------------------------------------------------- episode info

async function openEpisodeInfo(item, point) {
  const label = progressText(point);
  const modal = openModal({
    title: item.title, size: "sm",
    content: h("div", { class: "loading" }, "Loading episode…"),
    actions: [{ label: "Done", kind: "primary", value: true }],
  });
  try {
    const data = await API.showSeason(item.external_id, point.season, item.episode_group);
    if (modal.closed) return;
    const ep = (data.episodes || []).find((e) => e.episode === point.episode);
    if (!ep) {
      modal.setContent(h("p", { class: "modal-message" }, `No details found for ${label}.`));
      return;
    }
    modal.setContent(h("div", { class: "tracker-episode" },
      h("h3", { class: "tracker-episode-name" }, ep.name || `Episode ${point.episode}`),
      h("div", { class: "tracker-episode-meta" }, [label, ep.air_date ? fmtDateShort(ep.air_date) : "TBA"].join(" · ")),
      h("p", { class: "tracker-episode-overview" }, ep.overview || "No overview available yet.")));
  } catch (err) {
    if (!modal.closed) modal.setContent(h("p", { class: "modal-message" }, err.message));
  }
}

// ---------------------------------------------------------------- shows

function isAiringShow(t) {
  const s = t.show_status || "";
  if (t.kind === "tmdb_tv") return ["Returning Series", "In Production", "Planned", "Pilot"].includes(s) || !!t.next_air;
  return ["Releasing", "Not Yet Released"].includes(s) || !!t.next_ep;
}

function isFinishedShow(t) {
  const s = t.show_status || "";
  if (t.kind === "tmdb_tv") return ["Ended", "Canceled", "Cancelled"].includes(s);
  return ["Finished", "Cancelled"].includes(s);
}

function returningShow(t) {
  if (t.kind === "tmdb_tv") return !!t.next_air || ["Returning Series", "In Production", "Planned"].includes(t.show_status || "");
  return t.show_status === "Releasing" || !!t.next_ep;
}

function hasDatedReturn(t) {
  return !!((t.next_air && t.next_air.air_date) || (t.next_ep && t.next_ep.air_date));
}

// "Airing now" = mid-season with a concrete next episode. A season premiere
// as the next episode means between seasons, so it's deliberately "Airing
// soon". Continuous numbering never has a mid-run E1.
function isActivelyAiring(t) {
  if (t.kind === "tmdb_tv") {
    const na = t.next_air;
    return !!(na && na.air_date) && na.episode !== 1;
  }
  if (t.show_status === "Not Yet Released") return false;
  return !!t.next_ep && t.next_ep.episode !== 1;
}

function showProgressLine(t) {
  const p = progressText(t.progress);
  return p ? `Watched up to ${p}` : "No progress logged";
}

function showLatestLine(t) {
  if (t.kind === "tmdb_tv") {
    const la = t.last_aired;
    if (!la || la.season == null) return "No aired episodes found";
    return `Latest aired: S${la.season}E${la.episode}${la.air_date ? ` · ${fmtDateShort(la.air_date)}` : ""}`;
  }
  if (t.last_aired_ep == null) return "No airing data found";
  return `Latest aired: Ep ${t.last_aired_ep}${t.total_episodes ? ` of ${t.total_episodes}` : ""}`;
}

function showNextLine(t, prefix = "Next") {
  if (t.kind === "tmdb_tv") {
    const na = t.next_air;
    if (!na || !na.air_date) return null;
    return `${prefix}: S${na.season}E${na.episode} · ${fmtDateShort(na.air_date)}`;
  }
  const ne = t.next_ep;
  if (!ne) return null;
  return `${prefix}: Ep ${ne.episode}${ne.air_date ? ` · ${fmtDateShort(ne.air_date)}` : ""}`;
}

const nextOrTba = (t) => showNextLine(t, "Next episode") || "More is coming, date TBA";

function showActions(t) {
  return trackerActions(t, {
    noun: "show",
    finishedLabel: "Finished watching",
    setLabel: "Set episode",
    setTitle: "Pick an episode to mark watched up to",
    nextTitle: "Mark the next episode watched",
    nextVerb: "watched",
    unit: "episode",
    beforeEdit: (x) => [ignoreItem(x)],
    trailingInfo: (x) => (isAiringShow(x) ? [showNextLine(x, "Next episode") || "Returning soon — date TBA"] : []),
  });
}

function showCard(t, secondLine) {
  return card(t, { tags: cardTags(t), lines: [showProgressLine(t), secondLine], ...showActions(t) });
}

// A finished show with a season on the way (Returning sections, pinned).
function returningCard(t) {
  let line;
  const na = t.next_air;
  if (t.kind === "tmdb_tv" && na && na.air_date) {
    line = na.episode === 1
      ? `Season ${na.season} premieres ${fmtDateShort(na.air_date)}`
      : `S${na.season}E${na.episode} airs ${fmtDateShort(na.air_date)}`;
  } else if (t.kind === "anilist_show") {
    line = showNextLine(t) || "Still releasing new episodes";
  } else {
    line = `${t.show_status || "Returning"} — new season announced, date TBA`;
  }
  return card(t, {
    tags: [tag("Finished", "teal")],
    lines: [line],
    primary: watchAgainButton(t),
    menu: [
      pinItem(t),
      { label: "Finished watching", title: "Re-mark this show as finished",
        onClick: act(t, (e) => setStatus(e, "finished", { message: "Marked as finished." })) },
      holdItem(t), dropItem(t), ignoreItem(t), editItem(t),
    ],
  });
}

function pinnedShowCard(t) {
  if (t.status === "finished" && returningShow(t)) return returningCard(t);
  if (t.status === "finished") {
    return card(t, {
      tags: [tag("Finished", "teal")],
      lines: [showLatestLine(t)],
      primary: watchAgainButton(t),
      menu: [pinItem(t), holdItem(t), dropItem(t), ignoreItem(t), editItem(t)],
    });
  }
  return showCard(t, t.caught_up ? nextOrTba(t) : showLatestLine(t));
}

function renderShows(base) {
  const shows = base.filter((t) => t.kind === "tmdb_tv" || t.kind === "anilist_show");
  if (!shows.length) {
    return emptyState(`No trackable shows yet — link a Show to ${sourceLabel("tmdb_tv")} or ${linkLabel("anilist")} and set it to started (or finished, for returning-season alerts).`);
  }
  // On-hold entries (when shown) stay in their natural section — there is
  // deliberately no separate On hold section.
  const b = { pinned: [], returning: [], airing: [], finished: [], soon: [], nodata: [], tba: [] };
  for (const t of shows) {
    if (!TRACKED.has(t.status) || !onHoldVisible(t)) continue;
    if (t.pinned) b.pinned.push(t);
    else if (t.status === "finished") {
      if (returningShow(t)) (hasDatedReturn(t) ? b.returning : b.tba).push(t);
    } else if (isAiringShow(t)) (isActivelyAiring(t) ? b.airing : b.soon).push(t);
    else if (isFinishedShow(t)) b.finished.push(t);
    else b.nodata.push(t);
  }
  const latestOrNext = (t) => showCard(t, t.caught_up ? nextOrTba(t) : showLatestLine(t));
  const sections = [
    section("pinned", "Pinned", b.pinned, pinnedShowCard),
    section("returning", "Returning soon", b.returning, returningCard),
    section("airing", "Airing now", b.airing, latestOrNext),
    section("finished", "Finished airing", b.finished, (t) => showCard(t,
      t.caught_up ? `${t.show_status || "Finished"} — you've seen everything.` : showLatestLine(t))),
    section("soon", "Airing soon", b.soon, latestOrNext),
    section("nodata", "No data yet", b.nodata, (t) => showCard(t, "No airing data — try Refresh data, or check the link.")),
    section("tba", "Returning - TBA", b.tba, returningCard),
  ].filter(Boolean);
  return sections.length ? sections
    : emptyState("Nothing to show — finished shows appear here when a new season is on the way.");
}

// ---------------------------------------------------------------- comics

function latestSourceLabel(src) {
  return src === "override" ? "Custom" : linkLabel(src) || "unknown";
}

function comicProgressLine(t) {
  const p = progressText(t.progress);
  return p ? `Read up to ${p}` : "No progress logged";
}

function comicLatestLine(t) {
  if (t.latest_chapter == null) return "Latest chapter unknown";
  let s = `Latest: Ch ${t.latest_chapter}`;
  if (t.latest_chapter_at) s += ` · ${fmtDateShort(t.latest_chapter_at)}`;
  if (t.latest_source) s += ` (${latestSourceLabel(t.latest_source)})`;
  return s;
}

function comicActions(t) {
  return trackerActions(t, {
    noun: "comic",
    finishedLabel: "Finished reading",
    setLabel: "Set chapter",
    setTitle: "Pick the chapter you've read up to",
    nextTitle: "Mark the next chapter read",
    nextVerb: "read",
    unit: "chapter",
    afterPin: (x) => [fixLatestItem(x)],
    trailingInfo: (x) => [x.next_chapter_estimate
      ? `Next chapter ~ ${fmtDateShort(x.next_chapter_estimate)} (est.)` : null],
  });
}

function comicCard(t, { tags = cardTags(t), extra } = {}) {
  return card(t, { tags, lines: [comicProgressLine(t), comicLatestLine(t), extra], ...comicActions(t) });
}

// Deliberately reduced menu: the alert only needs acknowledging.
function backCard(t) {
  return card(t, {
    tags: [tag("Back!", "accent")],
    lines: [`Was on hiatus — now ${t.source_status || "Releasing"}`, comicLatestLine(t)],
    primary: { label: "Acknowledge", title: "Got it — remove from this list", onClick: act(t, (e) => acknowledge(e)) },
    menu: [
      t.status === "finished" ? { label: "Read again", title: "Move back to started",
        onClick: act(t, (e) => setStatus(e, "started", { message: "Moved to started." })) } : null,
      fixLatestItem(t),
      editItem(t),
    ],
  });
}

function renderComics(base) {
  const comics = base.filter((t) => t.kind === "comic");
  if (!comics.length) return emptyState(`No trackable comics yet — link a Comic to ${linkLabel("anilist")} and set it to started.`);
  const b = { pinned: [], back: [], releasing: [], hiatus: [], finished: [], nodata: [] };
  for (const t of comics) {
    if (!onHoldVisible(t)) continue;
    // A returned comic stays in Back from hiatus even when pinned.
    if (t.returned) {
      b.back.push(t);
      continue;
    }
    if (t.status !== "started" && t.status !== "on_hold") continue;
    if (t.pinned) {
      b.pinned.push(t);
      continue;
    }
    const s = t.source_status || "";
    if (s === "Releasing" || s === "Not Yet Released") b.releasing.push(t);
    else if (s === "Hiatus") b.hiatus.push(t);
    else if (s === "Finished" || s === "Cancelled") b.finished.push(t);
    else b.nodata.push(t);
  }
  const sections = [
    section("pinned", "Pinned", b.pinned, (t) => comicCard(t, {
      tags: [t.source_status === "Hiatus" ? tag("Hiatus", "plum") : null, ...cardTags(t)] })),
    section("back", "Back from hiatus", b.back, backCard),
    section("releasing", "Releasing", b.releasing, (t) => comicCard(t)),
    section("hiatus", "On hiatus", b.hiatus, (t) => comicCard(t, { tags: [tag("Hiatus", "plum"), ...cardTags(t)] })),
    section("finished", "Finished", b.finished, (t) => comicCard(t, {
      extra: t.caught_up ? "Complete — you've read everything." : null })),
    section("nodata", "No data yet", b.nodata, (t) => card(t, {
      tags: cardTags(t), lines: [comicProgressLine(t), "No status data — try Refresh data."], ...comicActions(t) })),
  ].filter(Boolean);
  return sections.length ? sections : emptyState("No started comics right now.");
}

// ---------------------------------------------------------------- upcoming

function tmdbNextWhat(t, na) {
  const point = `S${na.season}E${na.episode}`;
  const count = (t.episode_counts || {})[String(na.season)];
  if (na.episode === 1) return `${point} · Season premiere`;
  if (count === na.episode) return `${point} · Season finale`;
  return na.name ? `${point} · ${na.name}` : point;
}

function anilistNextWhat(t, ne) {
  if (ne.episode === t.total_episodes) return `Ep ${ne.episode} · Finale`;
  return ne.episode === 1 ? `Ep ${ne.episode} · Premiere` : `Ep ${ne.episode}`;
}

// { date (local YYYY-MM-DD), time (ms|null), what, estimate } or null.
function nextRelease(t) {
  if (t.kind === "tmdb_tv") {
    const na = t.next_air;
    return na && na.air_date ? { date: na.air_date, time: null, what: tmdbNextWhat(t, na) } : null;
  }
  if (t.kind === "anilist_show") {
    const ne = t.next_ep;
    if (!ne) return null;
    // airing_at gives the viewer's own day and time; air_date is a UTC day.
    const time = typeof ne.airing_at === "number" ? ne.airing_at * 1000 : null;
    const date = time != null ? localDate(new Date(time).toISOString()) : ne.air_date;
    return date ? { date, time, what: anilistNextWhat(t, ne) } : null;
  }
  if (!t.next_chapter_estimate) return null;
  const next = t.latest_chapter != null ? Math.floor(t.latest_chapter) + 1 : null;
  return { date: t.next_chapter_estimate, time: null, estimate: true,
    what: next != null ? `Ch ${next} (est.)` : "Next chapter (est.)" };
}

function onSchedule(t) {
  if (t.status === "started" || t.status === "on_hold") return onHoldVisible(t);
  return t.status === "finished" && t.kind !== "comic" && returningShow(t);
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The day heading already names relative days, so pair it with the date —
// and a plain date heading with the distance.
function whenLabel(r) {
  if (r.time != null) return fmtTime(r.time);
  if (r.days < 7) return fmtDateShort(r.date);
  return `In ${r.days} days`;
}

function upcomingRow(t, what, when, { estimate = false, timed = false, card = false } = {}) {
  const entry = getEntry(t.id);
  return h("article", { class: ["tracker-up-row", card && "card"] },
    poster(entry, t, "tracker-up-poster"),
    h("div", { class: "tracker-up-main" },
      titleEl(t, entry),
      aliasEl(entry),
      h("div", { class: "tracker-up-meta" },
        h("span", { class: ["tracker-up-what", estimate && "is-estimate"] }, what),
        h("span", { class: ["status", `status-${t.status}`] }, statusLabel(t.status)))),
    h("div", { class: ["tracker-up-when", timed && "is-time"] }, when));
}

// Dated days are full-width lists in time order; the undated TBA pile uses
// the two-column card grid of the Shows tab.
function dayGroup(label, rows, className, { grid = false } = {}) {
  return h("section", { class: ["tracker-day", className] },
    h("h2", { class: "section-heading" }, h("span", null, label), h("span", { class: "count" }, rows.length)),
    h("div", { class: grid ? "tracker-cards" : "card tracker-day-list" }, rows));
}

function renderUpcoming(base) {
  const dated = [];
  const tba = [];
  for (const t of base) {
    if (!TRACKED.has(t.status) || !onSchedule(t)) continue;
    const next = nextRelease(t);
    if (next) {
      const days = daysFromToday(next.date);
      if (days != null && days >= -1) dated.push({ t, days, ...next });
    } else if (t.kind !== "comic" && returningShow(t)) {
      tba.push(t);
    }
  }
  if (!dated.length && !tba.length) {
    return h("div", { class: "empty tracker-empty" },
      h("div", { class: "empty-title" }, "Nothing on the schedule"),
      "Upcoming episodes, returning seasons and chapter estimates for what you're following appear here.");
  }
  dated.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.time ?? Infinity) - (b.time ?? Infinity) ||
    (a.estimate ? 1 : 0) - (b.estimate ? 1 : 0) ||
    collator.compare(a.t.title || "", b.t.title || ""));

  const groups = [];
  let current = null;
  for (const r of dated) {
    if (!current || current.date !== r.date) {
      current = { date: r.date, days: r.days, rows: [] };
      groups.push(current);
    }
    current.rows.push(upcomingRow(r.t, r.what, whenLabel(r), { estimate: r.estimate, timed: r.time != null }));
  }
  const out = groups.map((g) => dayGroup(relativeDay(g.date), g.rows,
    g.days === 0 ? "is-today" : g.days < 0 ? "is-past" : null));
  if (tba.length) {
    const rows = tba.slice().sort((a, b) => collator.compare(a.title || "", b.title || ""))
      .map((t) => upcomingRow(t, t.show_status || "Returning", "TBA", { card: true }));
    out.push(dayGroup("Date TBA", rows, "is-tba", { grid: true }));
  }
  return out;
}
