// Stats page: KPI tiles and hand-built bar charts over GET /api/stats.

import { API } from "../core/api.js";
import { clear, h, sequence } from "../core/dom.js";
import { STATUS_LABELS, STATUS_ORDER as STATUS_KEYS, fmtDuration, fmtNumber, typeLabelPlural, typePlural } from "../core/format.js";
import { prefs } from "../core/store.js";
import { confirm } from "../ui/modal.js";

const TYPE_ORDER = ["Show", "Movie", "Comic", "Book", "Audiobook", "Other"];
// Validated palette slots for custom types; any beyond these fold into "Other"
// rather than inventing an indistinguishable hue.
const CUSTOM_SLOTS = 2;

let body, subtitle, notice, hiddenCheck;
let includeHidden = !!prefs.get("stats.hidden", false);
let rendered = false;
const seq = sequence();

export function mount(section) {
  subtitle = h("div", { class: "view-subtitle" });
  notice = h("div", { class: "stats-notice", role: "alert", hidden: true });
  body = h("div", { class: "stats-body" }, h("div", { class: "loading" }, "Crunching numbers…"));
  hiddenCheck = h("input", { type: "checkbox", checked: includeHidden, onChange: onHiddenToggle });
  clear(section,
    h("header", { class: "view-header" }, h("div", h("h1", { class: "view-title" }, "Stats"), subtitle),
      h("div", { class: "view-actions" }, h("label", { class: "check", title: "Include hidden entries" }, hiddenCheck,
        h("span", { class: "label-long" }, "Include hidden entries"), h("span", { class: "label-short" }, "Hidden")))),
    notice, body);
}

async function onHiddenToggle() {
  if (hiddenCheck.checked) {
    hiddenCheck.checked = false; // only set once confirmed
    if (!(await confirm({ title: "Include hidden entries?",
      message: "Hidden entries and entries from hidden categories will count toward Stats until this is unchecked.",
      confirmLabel: "Include them" }))) return;
    hiddenCheck.checked = true;
  }
  includeHidden = hiddenCheck.checked;
  prefs.set("stats.hidden", includeHidden);
  refresh();
}

export function activate() {
  refresh();
}

async function refresh() {
  const token = seq.next();
  notice.hidden = true;
  body.classList.toggle("is-refreshing", rendered);
  body.setAttribute("aria-busy", "true");
  try {
    const stats = await API.stats(includeHidden);
    if (!seq.isCurrent(token)) return;
    render(stats);
    rendered = true;
  } catch (err) {
    if (!seq.isCurrent(token)) return;
    showError(err);
  } finally {
    if (seq.isCurrent(token)) {
      body.classList.remove("is-refreshing");
      body.removeAttribute("aria-busy");
    }
  }
}

function retryButton() {
  return h("button", { type: "button", class: "btn btn-sm", onClick: () => refresh() }, "Retry");
}

// A failed refresh keeps the previous numbers on screen.
function showError(err) {
  if (rendered) {
    clear(notice, h("span", `Couldn't refresh stats. ${err.message}`), retryButton());
    notice.hidden = false;
    return;
  }
  clear(body, h("div", { class: "empty" },
    h("div", { class: "empty-title" }, "Couldn't load stats"),
    h("div", null, err.message),
    h("div", { class: "empty-action" }, retryButton())));
}

// ---- helpers ----

const count = (n, one, many) => `${fmtNumber(n)} ${n === 1 ? one : many}`;
const countType = (type, n) => `${fmtNumber(n)} ${typePlural(type, n)}`;

function pct(n, total) {
  if (!total) return "0%";
  const p = (n / total) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const ratio = (n, max) => (max ? Math.round((n / max) * 1e4) / 1e4 : 0);
const hours = (minutes) => count(Math.round(minutes / 60), "hour", "hours");

function statusName(key) {
  return STATUS_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ") : "Unknown");
}

// Every type in the payload: built-ins first in a fixed order, then custom
// types alphabetically so each keeps its color between renders.
function orderedTypes(s) {
  const seen = new Set(Object.keys(s.by_type || {}));
  for (const year of Object.values(s.completed_by_year || {})) Object.keys(year).forEach((t) => seen.add(t));
  const custom = [...seen].filter((t) => !TYPE_ORDER.includes(t)).sort((a, b) => a.localeCompare(b));
  return [...TYPE_ORDER.filter((t) => seen.has(t)), ...custom];
}

function typePalette(types) {
  const colors = new Map();
  let slot = 0;
  for (const t of types) {
    if (TYPE_ORDER.includes(t)) colors.set(t, `var(--stats-${t.toLowerCase()})`);
    else colors.set(t, slot < CUSTOM_SLOTS ? `var(--stats-custom-${++slot})` : "var(--stats-other)");
  }
  return colors;
}

// Years from the earliest to the latest present, gaps included, so the axis
// stays an honest timeline.
function yearRange(keys) {
  const years = keys.filter((y) => /^\d{4}$/.test(y)).map(Number);
  if (!years.length) return [];
  const out = [];
  for (let y = Math.min(...years); y <= Math.max(...years); y++) out.push(String(y));
  return out;
}

function card(title, content, { wide = false, note = null } = {}) {
  return h("section", { class: ["stats-card", wide && "stats-wide"], "aria-label": title },
    h("h2", { class: "section-heading stats-card-title" }, title),
    content,
    note ? h("p", { class: "stats-note" }, note) : null);
}

const swatch = (color) => h("span", { class: "stats-swatch", style: `--c:${color}`, "aria-hidden": "true" });

function legend(items) {
  return h("ul", { class: "stats-legend" },
    items.map((i) => h("li", swatch(i.color), i.label)));
}

// ---- marks ----

// rows: [{ label, value, text, color, title }]
function hbars(rows, label) {
  const max = Math.max(...rows.map((r) => r.value));
  return h("ul", { class: "stats-hbars", "aria-label": label },
    rows.map((r) => h("li", { class: "stats-hbar", title: r.title, "aria-label": r.title },
      h("span", { class: "stats-hbar-label" }, r.label),
      h("span", { class: "stats-hbar-track" },
        h("span", { class: "stats-hbar-fill", style: `--c:${r.color};--f:${ratio(r.value, max)}` }),
        h("span", { class: "stats-hbar-value" }, r.text)))));
}

// items: [{ label, total, title, segments: [{ value, color, title }] }].
// Segments stack bottom-up in the order given.
function columns(items, { label, variant, marker } = {}) {
  const max = Math.max(1, ...items.map((i) => i.total));
  const plot = h("ul", { class: ["stats-cols", variant && `stats-cols-${variant}`], "aria-label": label,
    style: `--n:${items.length}` },
  items.map((i) => h("li", { class: "stats-col", title: i.title, "aria-label": i.title },
    h("span", { class: "stats-col-cap" }, i.total ? fmtNumber(i.total) : ""),
    h("span", { class: "stats-col-stack", style: `--f:${ratio(i.total, max)}` },
      i.segments.filter((sg) => sg.value > 0).map((sg) =>
        h("span", { class: "stats-seg", style: `--c:${sg.color};flex-grow:${sg.value}`, title: sg.title || null }))),
    h("span", { class: "stats-col-label" }, i.label))));
  // Near either edge the label hangs inward so the scroller never clips it.
  const edge = marker && (marker.at < 0.2 ? "is-start" : marker.at > 0.8 ? "is-end" : null);
  const mark = marker && h("span", { class: ["stats-marker", edge], style: `left:${(marker.at * 100).toFixed(2)}%`,
    "aria-hidden": "true" }, h("span", { class: "stats-marker-label" }, marker.label));
  return h("div", { class: "stats-scroll" }, h("div", { class: ["stats-plot", mark && "has-marker"] }, plot, mark));
}

// ---- blocks (each returns null when it has nothing to show) ----

function tile(label, value, sub) {
  return h("div", { class: "stats-kpi" },
    h("div", { class: "stats-kpi-label" }, label),
    h("div", { class: "stats-kpi-value" }, value),
    sub ? h("div", { class: "stats-kpi-sub" }, sub) : null);
}

function kpis(s, types) {
  const c = s.consumed || {};
  const finished = (s.by_status || {}).finished || 0;
  const categories = types.filter((t) => (s.by_type || {})[t] > 0).length;
  return h("div", { class: "stats-kpis" },
    tile("Titles", fmtNumber(s.total), count(categories, "category", "categories")),
    finished ? tile("Finished", fmtNumber(finished), `${pct(finished, s.total)} of titles`) : null,
    s.average_rating != null
      ? tile("Average rating", Number(s.average_rating).toFixed(1), `${fmtNumber(s.rated_count)} rated`) : null,
    c.episodes ? tile("Episodes watched", fmtNumber(c.episodes)) : null,
    c.show_minutes ? tile("Show watchtime", fmtDuration(c.show_minutes), hours(c.show_minutes)) : null,
    c.chapters ? tile("Chapters read", fmtNumber(c.chapters)) : null,
    c.movies ? tile("Movies watched", fmtNumber(c.movies),
      c.movie_minutes ? `${fmtDuration(c.movie_minutes)} of movies` : null) : null,
    c.audiobook_minutes ? tile("Listening time", fmtDuration(c.audiobook_minutes), hours(c.audiobook_minutes)) : null,
    c.pages ? tile("Pages read", fmtNumber(c.pages)) : null);
}

function byCategory(s, types, colors) {
  const byType = s.by_type || {};
  const rows = types.filter((t) => byType[t] > 0).map((t) => ({
    label: typeLabelPlural(t),
    value: byType[t],
    text: fmtNumber(byType[t]),
    color: colors.get(t),
    title: `${typeLabelPlural(t)}: ${fmtNumber(byType[t])} (${pct(byType[t], s.total)})`,
  }));
  return rows.length ? card("By category", hbars(rows, "Entries by category")) : null;
}

function byStatus(s) {
  const counts = s.by_status || {};
  const extra = Object.keys(counts).filter((k) => !STATUS_KEYS.includes(k)).sort();
  const keys = [...STATUS_KEYS, ...extra].filter((k) => counts[k] > 0);
  if (!keys.length) return null;
  const sum = keys.reduce((a, k) => a + counts[k], 0);
  const colorOf = (k) => (STATUS_KEYS.includes(k) ? `var(--status-${k})` : "var(--stats-neutral)");
  const describe = (k) => `${statusName(k)}: ${fmtNumber(counts[k])} (${pct(counts[k], sum)})`;
  const bar = h("div", { class: "stats-stackbar", role: "img", "aria-label": keys.map(describe).join(", ") },
    keys.map((k) => h("span", { class: "stats-seg", style: `--c:${colorOf(k)};flex-grow:${counts[k]}`, title: describe(k) })));
  const rows = h("ul", { class: "stats-status-legend" },
    keys.map((k) => h("li",
      swatch(colorOf(k)),
      h("span", { class: "stats-status-name" }, statusName(k)),
      h("span", { class: "stats-status-count" }, fmtNumber(counts[k])),
      h("span", { class: "stats-status-pct" }, pct(counts[k], sum)))));
  return card("By status", [bar, rows]);
}

function ratings(s) {
  if (!s.rated_count) return null;
  const dist = s.ratings || {};
  const items = [];
  for (let n = 1; n <= 10; n++) {
    const v = dist[String(n)] || 0;
    items.push({ label: String(n), total: v, title: `Rated ${n}: ${count(v, "title", "titles")}`,
      segments: [{ value: v, color: "var(--accent)" }] });
  }
  const avg = s.average_rating;
  // Slot n is centered at (n - 0.5) / 10 of the plot width.
  const marker = avg != null ? { at: (avg - 0.5) / 10, label: `Avg ${Number(avg).toFixed(1)}` } : null;
  return card("Ratings", columns(items, { label: "Ratings from 1 to 10", variant: "ratings", marker }),
    { note: count(s.rated_count, "rated title", "rated titles") });
}

function timeSpent(s, colors) {
  const c = s.consumed || {};
  const rows = [["Show", c.show_minutes], ["Movie", c.movie_minutes], ["Audiobook", c.audiobook_minutes]]
    .filter(([, m]) => m > 0)
    .map(([t, m]) => ({
      label: typeLabelPlural(t),
      value: m,
      text: fmtDuration(m),
      color: colors.get(t) || `var(--stats-${t.toLowerCase()})`,
      title: `${typeLabelPlural(t)}: ${count(m, "minute", "minutes")} (${hours(m)})`,
    }));
  // One bar would only repeat its KPI tile.
  return rows.length > 1 ? card("Time spent", hbars(rows, "Time spent by category")) : null;
}

function completed(s, types, colors) {
  const data = s.completed_by_year || {};
  const years = yearRange(Object.keys(data));
  const unknown = s.unknown_completion || 0;
  if (!years.length && !unknown) return null;
  const note = unknown
    ? `${count(unknown, "finished entry has", "finished entries have")} no completion date`
    : null;
  if (!years.length) return card("Completed per year", null, { wide: true, note });

  // Custom types without a palette slot fold into "Other" here, so no two
  // segments share a color.
  const keyOf = (t) => (colors.get(t) === "var(--stats-other)" ? "Other" : t);
  const perYear = years.map((y) => {
    const row = {};
    for (const [t, n] of Object.entries(data[y] || {})) row[keyOf(t)] = (row[keyOf(t)] || 0) + n;
    return row;
  });
  const present = [...new Set(perYear.flatMap((r) => Object.keys(r)))];
  const stackTypes = [...types.filter((t) => present.includes(t)), ...present.filter((t) => !types.includes(t))];
  const colorOf = (t) => colors.get(t) || "var(--stats-other)";

  const items = years.map((y, i) => {
    const row = perYear[i];
    const total = stackTypes.reduce((a, t) => a + (row[t] || 0), 0);
    const parts = stackTypes.filter((t) => row[t]).map((t) => countType(t, row[t]));
    return {
      label: y, total,
      title: `${y}: ${fmtNumber(total)} finished${parts.length > 1 ? ` (${parts.join(", ")})` : ""}`,
      segments: stackTypes.map((t) => ({ value: row[t] || 0, color: colorOf(t), title: `${y}: ${countType(t, row[t] || 0)}` })),
    };
  });

  const table = h("details", { class: "stats-table" },
    h("summary", "Show as table"),
    h("div", { class: "stats-table-scroll" },
      h("table",
        h("thead", h("tr", h("th", { scope: "col" }, "Year"),
          stackTypes.map((t) => h("th", { scope: "col" }, typeLabelPlural(t))),
          h("th", { scope: "col" }, "Total"))),
        h("tbody", items.slice().reverse().map((item) => {
          const row = perYear[years.indexOf(item.label)];
          return h("tr", h("th", { scope: "row" }, item.label),
            stackTypes.map((t) => h("td", row[t] ? fmtNumber(row[t]) : "–")),
            h("td", fmtNumber(item.total)));
        })))));

  return card("Completed per year", [
    stackTypes.length > 1 ? legend(stackTypes.map((t) => ({ label: typeLabelPlural(t), color: colorOf(t) }))) : null,
    columns(items, { label: "Finished entries per year", variant: "years" }),
    note ? h("p", { class: "stats-note" }, note) : null,
    table,
  ], { wide: true });
}

function added(s) {
  const data = s.added_by_year || {};
  const years = yearRange(Object.keys(data));
  if (!years.length) return null;
  const items = years.map((y) => ({
    label: y, total: data[y] || 0, title: `${y}: ${fmtNumber(data[y] || 0)} added`,
    segments: [{ value: data[y] || 0, color: "var(--stats-added)" }],
  }));
  return card("Added per year", columns(items, { label: "Entries added per year", variant: "years" }), { wide: true });
}

// ---- render ----

function render(s) {
  const total = s.total || 0;
  // Collections count once per included member, so this can exceed the Ledger's title count.
  subtitle.textContent = `${count(total, "title", "titles")} · ${includeHidden ? "hidden included" : "hidden excluded"}`;
  if (!total) {
    clear(body, h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "No stats yet"),
      "Add entries to the ledger to see them here."));
    return;
  }
  const types = orderedTypes(s);
  const colors = typePalette(types);
  const halves = [byCategory(s, types, colors), byStatus(s), ratings(s), timeSpent(s, colors)].filter(Boolean);
  // An unpaired half-width card takes the whole row instead of leaving a hole.
  if (halves.length % 2) halves[halves.length - 1].classList.add("stats-wide");
  clear(body,
    kpis(s, types),
    h("div", { class: "stats-grid" }, halves, completed(s, types, colors), added(s)));
  // Year charts can overflow on phones; start at the most recent year.
  requestAnimationFrame(() => {
    for (const el of body.querySelectorAll(".stats-scroll")) el.scrollLeft = el.scrollWidth;
  });
}
