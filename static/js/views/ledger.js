// The Ledger: the whole catalog as a list or a poster grid.
//
// Filtering and search run over real entries first; grouping is a rendering
// layer applied afterwards, so a Group row holds exactly the members that
// survived the active filters.

import { h, icon, iconButton, clear, debounce } from "../core/dom.js";
import { on, prefs, state, hiddenCategories, isHiddenEntry } from "../core/store.js";
import {
  STATUS_LABELS, TYPES, fmtDate, localDate, normalizeSearch, plural, statusLabel,
  typeLabelPlural, typeOrder, typePlural, verbs,
} from "../core/format.js";
import {
  collator, collectionRating, comparator, effectiveCompleteDate, groupDate, groupRating, groupStatus,
  includedMembers, isCollection, isGroup, isStructural, isUnknownComplete, kindType, matchesQuery,
  memberTypes, orderedMembers, posterOf, rowDate,
} from "../core/model.js";
import { confirm } from "../ui/modal.js";
import { menuButton } from "../ui/menu.js";
import { dropdown } from "../ui/dropdown.js";
import { poster } from "../ui/poster.js";
import { deleteEntry, setStatus } from "../features/actions.js";
import { openDetails } from "../features/details.js";
import { openEntryForm } from "../features/entry-form.js";
import { openRateDialog } from "../features/rate.js";
import { openTitleOptions } from "../features/titles.js";
import { inTracker, showInTracker } from "./tracker.js";

const SORTS = [
  ["modified", "Date modified"], ["added", "Date added"], ["complete", "Date completed"],
  ["released", "Date released"], ["rating", "Rating"], ["title", "Title"],
];
const DIR_LABELS = { rating: ["Low to high", "High to low"], title: ["A to Z", "Z to A"] };

const ui = {
  status: "all",
  type: "all",
  query: "",
  page: 1,
  sort: prefs.get("ledger.sort", "modified"),
  dir: prefs.get("ledger.dir", "desc"),
  layout: prefs.get("ledger.layout", "list"),
  expanded: new Set(prefs.get("ledger.expanded", [])),
  cols: 4,
};
let els = null;
let active = false;

const defaultDir = (key) => (key === "title" ? "asc" : "desc");
const pageSize = () => prefs.get("ledger.pageSize", 50);
const dateMode = () => prefs.get("ledger.dateMode", "relevant");

// ---------------------------------------------------------------- data

function typeOptions() {
  const present = new Set(state.entries.map((e) => e.type));
  const custom = [...present].filter((t) => !TYPES.includes(t) && t !== "Group").sort(collator.compare);
  return [["all", "All types"], ...typeOrder(custom).map((t) => [t, typeLabelPlural(t)]), ["hidden", "Hidden"]];
}

function collectionHasType(group, type) {
  return includedMembers(group).some((m) => kindType(m.kind) === type);
}

function byType(list) {
  const t = ui.type;
  if (t === "all") return list.filter((e) => !isHiddenEntry(e));
  if (t === "hidden") return list.filter(isHiddenEntry);
  if (t === "Group") return list.filter((e) => !e.hidden && (isGroup(e) || !!e.group));
  return list.filter((e) => !e.hidden && (e.type === t || (isCollection(e) && collectionHasType(e, t))));
}

function bucket(list, opts) {
  const groups = new Map(state.entries.filter((e) => isGroup(e) && (!e.hidden || opts.hiddenView)).map((e) => [e.id, e]));
  const totals = new Map();
  for (const e of state.entries) {
    if (!opts.hiddenView && isHiddenEntry(e)) continue;
    if (e.group && groups.has(e.group)) totals.set(e.group, (totals.get(e.group) || 0) + 1);
  }
  const members = new Map();
  for (const e of list) {
    if (e.group && groups.has(e.group)) {
      if (!members.has(e.group)) members.set(e.group, []);
      members.get(e.group).push(e);
    }
  }
  // Rating sort shows manual members individually unless the Group keeps
  // its own row; a collection has no catalog members to dissolve into.
  const keepsRow = (g) => g.collection || (!opts.hiddenView && (!opts.dissolve || g.always_group || g.rating != null));
  const units = [];
  const seen = new Set();
  const addGroup = (g, own = true) => {
    seen.add(g.id);
    units.push({ kind: "group", group: g, members: own ? members.get(g.id) || [] : [], total: totals.get(g.id) || 0 });
  };
  for (const e of list) {
    if (isGroup(e)) continue;
    const g = e.group ? groups.get(e.group) : null;
    if (!g || !keepsRow(g)) units.push({ kind: "entry", entry: e });
    else if (!seen.has(g.id)) addGroup(g);
  }
  for (const e of list) {
    if (!isGroup(e) || seen.has(e.id)) continue;
    // Empty groups show only on the All tab; collections have a status, so
    // they always get a row. Standalone members don't repeat under the group.
    if (e.collection || (opts.keepEmpty && (keepsRow(e) || (opts.hiddenView && e.hidden)))) addGroup(e, keepsRow(e));
  }
  return units;
}

// Stand-in used to sort a group; its own dates/rating rank it when it has
// no visible members, and renaming it still moves it under Date modified.
function groupProxy(g) {
  return { id: g.id, title: g.title, date_added: g.date_added, date_modified: g.date_modified,
    date_complete: effectiveCompleteDate(g) || null, status: g.status || null,
    rating: g.rating ?? null, details: g.details };
}

function representative(unit, cmp) {
  if (unit.kind === "entry") return unit.entry;
  const proxy = groupProxy(unit.group);
  if (ui.sort === "title") return proxy;
  return unit.members.reduce((best, m) => (cmp(m, best) < 0 ? m : best), proxy);
}

function unitRating(unit) {
  return unit.kind === "entry" ? unit.entry.rating : groupRating(unit.group, unit.members).value;
}

function unitCompleteDate(unit) {
  if (unit.kind === "entry") return effectiveCompleteDate(unit.entry);
  if (unit.group.collection || isUnknownComplete(unit.group)) return effectiveCompleteDate(unit.group);
  return unit.members.reduce((best, m) => {
    const c = effectiveCompleteDate(m);
    return c > best ? c : best;
  }, "");
}

function computeView() {
  const typed = byType(state.entries);
  const counts = { all: 0 };
  for (const e of typed) {
    if (isGroup(e) && !e.collection) continue;
    counts.all += 1;
    counts[e.status] = (counts[e.status] || 0) + 1;
  }
  let list = ui.status === "all" ? typed
    : typed.filter((e) => (isGroup(e) && !e.collection) || e.status === ui.status);

  let selfMatched = null;
  if (ui.query) {
    const qn = normalizeSearch(ui.query);
    selfMatched = new Set(list.filter((e) => matchesQuery(e, qn)).map((e) => e.id));
    // A matching Group title pulls in all of its (filtered) members.
    const groupHits = new Set(list.filter((e) => isGroup(e) && selfMatched.has(e.id)).map((e) => e.id));
    list = list.filter((e) => selfMatched.has(e.id) || (e.group && groupHits.has(e.group)));
  }

  const hiddenView = ui.type === "hidden";
  const units = bucket(list, { keepEmpty: ui.status === "all", dissolve: ui.sort === "rating", hiddenView });
  for (const u of units) {
    if (u.kind !== "group") continue;
    const saved = ui.expanded.has(u.group.id);
    if (u.group.always_group) {
      u.expanded = saved;
      continue;
    }
    // Auto-expand (per render only) when filters show just part of a group,
    // or when the search matched a member itself rather than the group title.
    const partial = u.members.length > 0 && u.members.length !== u.total;
    const memberHit = !!selfMatched && u.members.some((m) => selfMatched.has(m.id));
    u.expanded = saved || partial || memberHit;
  }

  const cmp = ui.sort === "rating" ? comparator("modified", "desc") : comparator(ui.sort, ui.dir);
  for (const u of units) u.rep = representative(u, cmp);
  units.sort((a, b) => cmp(a.rep, b.rep));

  let sections = [{ heading: null, units }];
  if (ui.sort === "complete") {
    const dated = units.filter((u) => unitCompleteDate(u));
    const rest = units.filter((u) => !unitCompleteDate(u));
    sections = [{ heading: null, units: dated }, { heading: "Unfinished", units: rest }].filter((s) => s.units.length);
  } else if (ui.sort === "rating") {
    const byRating = new Map();
    for (const u of units) {
      const r = unitRating(u);
      const key = r == null ? "Unrated" : `Rated ${r}`;
      if (!byRating.has(key)) byRating.set(key, { heading: key, value: r, units: [] });
      byRating.get(key).units.push(u);
    }
    sections = [...byRating.values()].sort((a, b) => {
      if (a.value == null) return 1;
      if (b.value == null) return -1;
      return ui.dir === "asc" ? a.value - b.value : b.value - a.value;
    });
  }
  return { sections, counts, total: units.length };
}

// ---------------------------------------------------------------- rows

// Partial dates keep the MM-DD-YYYY shape, unknown parts masked.
function dateText(value) {
  if (!value) return "—";
  const [y, m, d] = localDate(value).split("-");
  if (d) return fmtDate(value);
  const mask = () => h("span", { class: "date-mask" }, "??");
  return [m || mask(), "-", mask(), "-", y];
}

function dateNode(info) {
  return h("span", { class: ["ledger-date", `date-${info.kind}`, info.aggregate && "date-aggregate"],
    title: info.value ? `${info.label} — ${fmtDate(info.value)}` : info.label }, dateText(info.value));
}

function ratingNode(value, { derived, count, onRate, allowRate = true } = {}) {
  if (value != null) {
    return h("span", { class: ["stamp", derived && "derived"],
      title: derived ? `Average of ${plural(count, "rating")}` : `Rated ${value}/10` }, value);
  }
  if (!allowRate) return h("span", { class: "rate-btn is-disabled", title: "Not rateable", "aria-hidden": "true" }, "rate");
  return h("button", { type: "button", class: "rate-btn", title: "Rate", onClick: (e) => { e.stopPropagation(); onRate(); } }, "rate");
}

// Every entry has the same menu shape: Show in tracker, status moves for
// where it stands, then details, rating, synonym and deletion.
function entryMenu(entry) {
  const items = [];
  const structural = isStructural(entry.type);
  const v = verbs(entry.type);
  if (inTracker(entry)) {
    items.push({ label: "Show in tracker", onClick: () => showInTracker(entry.id) });
  }
  if (entry.status === "planned") {
    items.push({ label: "Start", onClick: () => setStatus(entry, "started", { message: "Started." }) });
  } else if (entry.status === "on_hold" || entry.status === "dropped") {
    items.push({ label: "Resume", onClick: () => setStatus(entry, "started", { message: "Resumed." }) });
  }
  if (entry.status !== "finished") items.push({ label: v.finish, onClick: () => setStatus(entry, "finished") });
  if (entry.status === "started") {
    items.push({ label: "Put on hold", onClick: () => setStatus(entry, "on_hold", { message: "Put on hold." }) });
  }
  if (entry.status === "started" || entry.status === "on_hold") {
    items.push({ label: structural ? "Drop series" : "Drop", onClick: () => setStatus(entry, "dropped", { message: "Dropped." }) });
  }
  if (items.length) items.push({ divider: true });
  items.push({ label: "Details", onClick: () => openDetails(entry) });
  if (entry.status !== "planned") {
    items.push({ label: entry.rating != null ? "Change rating" : "Rate", onClick: () => openRateDialog(entry) });
  }
  items.push({ label: entry.synonym ? "Change synonym" : "Add synonym", onClick: () => openTitleOptions({ entry, mode: "synonym" }) });
  items.push({ label: "Delete entry", danger: true, onClick: () => deleteEntry(entry) });
  return items;
}

function groupMenu(group) {
  return [
    { label: group.collection ? "Show collection" : "Show members", onClick: () => openDetails(group) },
    { divider: true },
    { label: "Delete group", danger: true, onClick: () => deleteEntry(group) },
  ];
}

// Phones use the short label so the meta line under the title fits.
const SHORT_TYPES = { Audiobook: "Audio" };

function typeTag(type, where = "title") {
  const short = SHORT_TYPES[type];
  return h("span", { class: ["tag", "ledger-type", `ledger-type-${where}`, short && "has-short"], title: type },
    h("span", { class: "type-long" }, type), short ? h("span", { class: "type-short" }, short) : null);
}

// Desktop shows the type beside the title; phones move it to the meta line.
function metaLine(type, ...children) {
  return h("div", { class: "ledger-meta" }, typeTag(type, "meta"), children);
}

// Desktop lays these out as row columns; phones give them their own line.
function rowFoot(...children) {
  return h("div", { class: "ledger-foot" }, children);
}

function titleLine(title, type) {
  return h("div", { class: "ledger-titleline" }, title, typeTag(type));
}

function statusPill(status) {
  return h("span", { class: `status status-${status}` }, statusLabel(status));
}

function entryRow(entry, { child = false } = {}) {
  return h("div", { class: ["ledger-row", child && "is-child"], dataset: { id: entry.id } },
    poster(posterOf(entry), { type: entry.type }),
    h("div", { class: "ledger-main" },
      titleLine(h("button", { type: "button", class: "ledger-title", onClick: () => openDetails(entry) }, entry.title), entry.type),
      entry.synonym ? h("div", { class: "ledger-sub" }, entry.synonym) : null),
    rowFoot(metaLine(entry.type, statusPill(entry.status), dateNode(rowDate(entry, dateMode()))),
      ratingNode(entry.rating, { allowRate: entry.status !== "planned", onRate: () => openRateDialog(entry) }),
      h("div", { class: "ledger-actions" },
        menuButton(entryMenu(entry)),
        iconButton("edit", "Edit", () => openEntryForm(entry)))));
}

function summarize(types) {
  if (!types.length) return "No items";
  const counts = new Map();
  for (const t of types) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${typePlural(t, n)}`).join(", ");
}

function groupSummary(group, members) {
  const known = !group.collection || (group.members || []).length > 0;
  return known ? summarize(memberTypes(group, members)) : null;
}

function toggleGroup(id, expanded) {
  if (expanded) ui.expanded.delete(id);
  else ui.expanded.add(id);
  prefs.set("ledger.expanded", [...ui.expanded]);
  render();
}

function groupRow(unit) {
  const { group, members, expanded } = unit;
  const status = groupStatus(group, members);
  const rating = groupRating(group, members);
  const summary = groupSummary(group, members);
  const toggle = () => toggleGroup(group.id, expanded);
  return h("div", { class: ["ledger-row", "is-group", expanded && "is-open"], dataset: { id: group.id } },
    poster(posterOf(group), { type: "Group", className: "poster-stack" }),
    h("div", { class: "ledger-main" },
      titleLine(h("button", { type: "button", class: "ledger-title", onClick: toggle, "aria-expanded": String(!!expanded) }, group.title), "Group"),
      summary ? h("div", { class: "ledger-sub" }, summary) : null),
    rowFoot(metaLine("Group",
      status ? statusPill(status) : h("span", { class: "status-slot" }),
      dateNode(groupDate(group, members, dateMode()))),
    ratingNode(rating.value, { derived: !rating.own, count: rating.count, allowRate: false }),
    h("div", { class: "ledger-actions" },
      iconButton(expanded ? "chevronDown" : "chevronRight", expanded ? "Collapse" : "Expand", toggle),
      iconButton("edit", "Edit", () => openEntryForm(group)))));
}

function collectionMemberRow(group, member) {
  const type = kindType(member.kind);
  const rating = collectionRating(group, member.ref);
  return h("div", { class: ["ledger-row", "is-child", "is-source-member"] },
    poster(member.thumb_url, { type }),
    h("div", { class: "ledger-main" },
      titleLine(member.url ? h("a", { class: "ledger-title", href: member.url, target: "_blank", rel: "noopener noreferrer" }, member.title || "Untitled")
        : h("span", { class: "ledger-title" }, member.title || "Untitled"), type)),
    rowFoot(metaLine(type, group.status ? statusPill(group.status) : h("span", { class: "status-slot" }),
      dateNode({ value: member.release_date || "", kind: "released", label: "Date released" })),
    ratingNode(rating, { onRate: () => openRateDialog(group, member) }),
    h("div", { class: "ledger-actions" },
      member.url ? h("a", { class: "icon-btn", href: member.url, target: "_blank", rel: "noopener noreferrer",
        title: "Open on the source site", "aria-label": "Open on the source site" }, icon("external", 17)) : null)));
}

function listUnit(unit) {
  if (unit.kind === "entry") return [entryRow(unit.entry)];
  const nodes = [groupRow(unit)];
  if (unit.expanded) {
    if (unit.group.collection) {
      for (const m of includedMembers(unit.group)) nodes.push(collectionMemberRow(unit.group, m));
    } else {
      for (const m of orderedMembers(unit.members, unit.group.member_sort, unit.group.member_order)) {
        nodes.push(entryRow(m, { child: true }));
      }
    }
  }
  return nodes;
}

// ---------------------------------------------------------------- grid

// Cards stretch to their row's height and pin the date/status footer to the
// bottom, so titles with and without a second line or alias still align.
function gridCard(unit) {
  const isGrp = unit.kind === "group";
  const entry = isGrp ? unit.group : unit.entry;
  const status = isGrp ? groupStatus(entry, unit.members) : entry.status;
  const rating = isGrp ? groupRating(entry, unit.members) : { value: entry.rating, own: true };
  const info = isGrp ? groupDate(entry, unit.members, dateMode()) : rowDate(entry, dateMode());
  const count = isGrp ? (entry.collection ? includedMembers(entry).length : unit.members.length) : 0;
  const sub = isGrp ? groupSummary(entry, unit.members) : entry.synonym;
  const open = () => openDetails(entry);
  return h("article", { class: ["ledger-card", isGrp && "is-group"], dataset: { id: entry.id } },
    h("div", { class: "ledger-card-art" },
      h("button", { type: "button", class: "ledger-card-cover", onClick: open, "aria-label": `Details for ${entry.title}` },
        poster(posterOf(entry), { size: "lg", type: entry.type })),
      rating.value != null ? h("span", { class: ["stamp", !rating.own && "derived"],
        title: rating.own ? `Rated ${rating.value}/10` : `Average of ${plural(rating.count, "rating")}` }, rating.value) : null,
      isGrp ? h("span", { class: "ledger-card-count", title: plural(count, "item") }, icon("layers", 13), count) : null),
    h("div", { class: ["ledger-card-text", sub && "has-sub"] },
      h("button", { type: "button", class: "ledger-card-title", onClick: open }, entry.title),
      sub ? h("div", { class: "ledger-card-sub" }, sub) : null),
    h("div", { class: "ledger-card-foot" },
      h("div", { class: "ledger-card-tags" }, typeTag(entry.type, "meta"), status ? statusPill(status) : null),
      h("div", { class: "ledger-card-row" },
        dateNode(info),
        h("div", { class: "ledger-card-actions" },
          menuButton(isGrp ? groupMenu(entry) : entryMenu(entry), { class: "icon-btn icon-btn-sm" }),
          iconButton("edit", "Edit", () => openEntryForm(entry), { class: "icon-btn-sm", size: 16 })))));
}

// Grid columns are set here rather than by auto-fill so a page can hold
// whole rows.
const GRID_MIN = 150;
const GRID_GAP = 16;

function updateColumns() {
  const width = els.body.clientWidth;
  if (!width) return false;
  const cols = Math.max(2, Math.floor((width + GRID_GAP) / (GRID_MIN + GRID_GAP)));
  if (cols === ui.cols) return false;
  ui.cols = cols;
  els.body.style.setProperty("--grid-cols", String(cols));
  return true;
}

function effectivePageSize() {
  const size = pageSize();
  if (size === "all" || ui.layout !== "grid") return size;
  return Math.ceil(size / ui.cols) * ui.cols;
}

// ---------------------------------------------------------------- render

function renderPager(total, size) {
  const pages = size === "all" ? 1 : Math.max(1, Math.ceil(total / size));
  ui.page = Math.min(Math.max(1, ui.page), pages);
  if (pages <= 1) return clear(els.pager);
  const go = (p) => { ui.page = p; render(); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const select = dropdown(h("select", { class: "select pager-select", "aria-label": "Page",
    onChange: (e) => go(Number(e.target.value)) },
    Array.from({ length: pages }, (_, i) => h("option", { value: i + 1, selected: i + 1 === ui.page }, `Page ${i + 1}`))));
  const from = (ui.page - 1) * size + 1;
  clear(els.pager,
    h("span", { class: "pager-info" }, `${from}–${Math.min(total, from + size - 1)} of ${total}`),
    h("div", { class: "pager-controls" },
      iconButton("first", "First page", () => go(1), { disabled: ui.page === 1 }),
      iconButton("chevronLeft", "Previous page", () => go(ui.page - 1), { disabled: ui.page === 1 }),
      select, h("span", { class: "pager-total" }, `of ${pages}`),
      iconButton("chevronRight", "Next page", () => go(ui.page + 1), { disabled: ui.page === pages }),
      iconButton("last", "Last page", () => go(pages), { disabled: ui.page === pages })));
}

function renderStatusChips(counts) {
  clear(els.statusChips, [["all", "All"], ...Object.entries(STATUS_LABELS)].map(([key, label]) =>
    h("button", { type: "button", class: ["chip", ui.status === key && "active"],
      onClick: () => { ui.status = key; ui.page = 1; render(); } },
      label, h("span", { class: "count" }, counts[key] || 0))));
}

function renderSortControls() {
  els.sort.value = ui.sort;
  const [ascLabel, descLabel] = DIR_LABELS[ui.sort] || ["Oldest first", "Newest first"];
  const label = ui.dir === "asc" ? ascLabel : descLabel;
  clear(els.dirBtn, icon(ui.dir === "asc" ? "sortAsc" : "sortDesc"));
  els.dirBtn.title = `${label} — click to reverse`;
  els.dirBtn.setAttribute("aria-label", `Sort order: ${label}`);
  for (const btn of els.layoutBtns.children) btn.classList.toggle("active", btn.dataset.layout === ui.layout);
}

function render() {
  if (!els || !active) return;
  const { sections, counts, total } = computeView();
  renderStatusChips(counts);
  renderSortControls();
  // Counted like the All chip: every title, with plain Groups as containers only.
  const titles = state.entries.filter((e) => !(isGroup(e) && !e.collection) && !isHiddenEntry(e)).length;
  const filtered = ui.query || ui.type !== "all" || ui.status !== "all";
  els.subtitle.textContent = `${plural(titles, "title")}${filtered ? ` · ${plural(total, "result")}` : ""}`;

  updateColumns();
  const size = effectivePageSize();
  const flat = sections.flatMap((s) => s.units.map((u) => ({ heading: s.heading, unit: u })));
  renderPager(flat.length, size);
  const slice = size === "all" ? flat : flat.slice((ui.page - 1) * size, ui.page * size);

  if (!flat.length) {
    const empty = state.entries.length
      ? h("div", { class: "empty" }, h("div", { class: "empty-title" }, "Nothing matches"), "Try another filter or search.")
      : h("div", { class: "empty" }, h("div", { class: "empty-title" }, "Your catalog is empty"),
        "Add the first thing you're watching, reading or listening to.",
        h("div", { class: "empty-action" }, h("button", { type: "button", class: "btn btn-primary", onClick: () => openEntryForm() }, "+ Add entry")));
    return clear(els.body, empty);
  }
  const nodes = [];
  let heading = Symbol("none");
  let container = null;
  for (const { heading: hd, unit } of slice) {
    if (hd !== heading || !container) {
      heading = hd;
      if (hd) nodes.push(h("h2", { class: "section-heading" }, hd));
      container = h("div", { class: ui.layout === "grid" ? "ledger-grid" : "ledger-list" });
      nodes.push(container);
    }
    if (ui.layout === "grid") container.append(gridCard(unit));
    else container.append(...listUnit(unit));
  }
  clear(els.body, nodes);
}

// ---------------------------------------------------------------- mount

async function onTypeChange(e) {
  const value = e.target.value;
  const revealsHidden = value === "hidden" || hiddenCategories().has(value);
  if (revealsHidden && !(await confirm({ title: "Show hidden entries?",
    message: "This view contains hidden entries. Show them anyway?", confirmLabel: "Show them" }))) {
    e.target.value = ui.type;
    return;
  }
  ui.type = value;
  ui.page = 1;
  render();
}

function buildTypeSelect() {
  return dropdown(h("select", { class: "select", "aria-label": "Filter by type", onChange: onTypeChange },
    typeOptions().map(([value, label]) => h("option", { value, selected: value === ui.type }, label))));
}

export function mount(section) {
  const search = h("input", { type: "search", class: "input ledger-search-input", placeholder: "Search titles…",
    autocomplete: "off", "aria-label": "Search titles" });
  const runSearch = debounce(() => { ui.query = search.value.trim(); ui.page = 1; render(); }, 150);
  search.addEventListener("input", runSearch);

  const sort = h("select", { class: "select", "aria-label": "Sort by",
    onChange: (e) => { ui.sort = e.target.value; ui.dir = defaultDir(ui.sort); persistSort(); ui.page = 1; render(); } },
    SORTS.map(([value, label]) => h("option", { value }, label)));
  const dirBtn = h("button", { type: "button", class: "icon-btn ledger-dir",
    onClick: () => { ui.dir = ui.dir === "asc" ? "desc" : "asc"; persistSort(); ui.page = 1; render(); } });
  const layoutBtns = h("div", { class: "segmented", role: "group", "aria-label": "Layout" },
    [["list", "list", "List"], ["grid", "grid", "Grid"]].map(([value, ic, label]) =>
      h("button", { type: "button", dataset: { layout: value }, title: `${label} view`, "aria-label": `${label} view`,
        onClick: () => { ui.layout = value; prefs.set("ledger.layout", value); render(); } }, icon(ic, 16))));

  els = {
    search, sort, dirBtn, layoutBtns,
    typeWrap: h("div", { class: "ledger-type-filter" }, buildTypeSelect()),
    subtitle: h("div", { class: "view-subtitle" }),
    statusChips: h("div", { class: "chips ledger-status" }),
    body: h("div", { class: "ledger-body" }),
    pager: h("nav", { class: "ledger-pager", "aria-label": "Pages" }),
  };
  section.append(
    h("div", { class: "view-header" },
      h("div", null, h("h1", { class: "view-title" }, "Ledger"), els.subtitle),
      h("div", { class: "view-actions" }, layoutBtns)),
    h("div", { class: "ledger-toolbar" },
      h("label", { class: "ledger-search" }, icon("search", 17), search),
      h("div", { class: "ledger-controls" }, els.typeWrap,
        h("div", { class: "ledger-sort" }, dropdown(sort), dirBtn))),
    els.statusChips, els.body, els.pager);

  on("entries", () => {
    // Custom types can appear or disappear with any edit.
    clear(els.typeWrap, buildTypeSelect());
    render();
  });
  on("prefs", render);
  on("tracker-updated", render); // "Show in tracker" depends on tracker data
  new ResizeObserver(() => {
    if (updateColumns() && ui.layout === "grid") render();
  }).observe(els.body);
}

function persistSort() {
  prefs.set("ledger.sort", ui.sort);
  prefs.set("ledger.dir", ui.dir);
}

export function activate() {
  active = true;
  render();
}

export function focusSearch() {
  if (els) requestAnimationFrame(() => els.search.focus());
}
