// Formatting and parsing shared by every view.

export const STATUS_LABELS = {
  started: "Started",
  finished: "Finished",
  planned: "Planned",
  on_hold: "On hold",
  dropped: "Dropped",
};
export const STATUS_ORDER = ["started", "finished", "planned", "on_hold", "dropped"];

export const TYPES = ["Show", "Comic", "Movie", "Book", "Audiobook", "Other"];

// Type pickers: built-ins, then custom types, then Group just before Other.
export function typeOrder(custom = []) {
  return [...TYPES.filter((t) => t !== "Other"), ...custom, "Group", "Other"];
}
const TYPE_PLURALS = {
  Show: "shows", Comic: "comics", Movie: "movies", Book: "books",
  Audiobook: "audiobooks", Other: "others", Group: "groups",
};
export const TYPE_ICONS = {
  Show: "tv", Comic: "comic", Movie: "film", Book: "book", Audiobook: "headphones", Group: "layers",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || "";
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function typePlural(type, n) {
  if (n === 1) return type.toLowerCase();
  return TYPE_PLURALS[type] || `${type.toLowerCase()}s`;
}

export function typeLabelPlural(type) {
  const p = TYPE_PLURALS[type] || `${type.toLowerCase()}s`;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// Medium-specific wording; stored statuses stay medium-neutral.
export function verbs(type) {
  if (type === "Comic" || type === "Book") return { done: "read", finish: "Finished reading", again: "Reread", repeated: "Reread", unit: "chapter" };
  if (type === "Audiobook") return { done: "listened", finish: "Finished listening", again: "Relisten", repeated: "Relistened", unit: "part" };
  return { done: "watched", finish: "Finished watching", again: "Rewatch", repeated: "Rewatched", unit: "episode" };
}

// ---- dates ----
// date_added/date_modified are UTC timestamps shown in the viewer's local
// calendar; date_complete and source dates are plain dates shown as-is.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayISO() {
  return isoOf(new Date());
}

export function localDate(value) {
  if (!value) return "";
  if (/^\d{4}(-\d{2}){0,2}$/.test(value)) return value;
  const d = new Date(value);
  return isNaN(d) ? String(value).slice(0, 10) : isoOf(d);
}

// "2026-09-22" -> "09-22-2026"; partial dates degrade to "09-2026" / "2026".
export function fmtDate(value) {
  const [y, m, day] = localDate(value).split("-");
  if (!y) return "";
  return [m, day, y].filter(Boolean).join("-");
}

// "Sep 22" this year, else "Sep 22, 2024".
export function fmtDateShort(value) {
  const d = localDate(value);
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return fmtDate(value);
  return y === new Date().getFullYear() ? `${MONTHS[m - 1]} ${day}` : `${MONTHS[m - 1]} ${day}, ${y}`;
}

export function daysFromToday(isoDate) {
  const d = localDate(isoDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split("-").map(Number);
  const today = new Date();
  const a = Date.UTC(y, m - 1, day);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86400000);
}

export function relativeDay(isoDate) {
  const n = daysFromToday(isoDate);
  if (n == null) return "";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) {
    const [y, m, day] = localDate(isoDate).split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: "long" });
  }
  return fmtDateShort(isoDate);
}

// ---- progress ----

export function progressText(p) {
  if (!p) return "";
  if (typeof p === "string") return p;
  if (p.season != null) return `S${p.season}E${p.episode}`;
  if (p.episode != null) return `Ep ${p.episode}`;
  if (p.chapter != null) return `Ch ${p.chapter}`;
  return p.text || "";
}

// Mirrors the server parser so pickers can pre-mark typed progress.
export function parseProgress(text, type) {
  if (text && typeof text === "object") return text;
  const t = (text || "").trim();
  if (!t) return null;
  if (type === "Show" || type === "Comic") {
    let m = t.match(/^s\s*(\d+)\s*e\s*(\d+)$/i) || t.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (m) return { season: +m[1], episode: +m[2] };
    m = t.match(/^(?:e|ep|episode)\.?\s*(\d+)$/i);
    if (m) return { episode: +m[1] };
    m = t.match(/^(?:ch|chapter)\.?\s*(\d+(?:\.\d+)?)$/i);
    if (m) return { chapter: parseFloat(m[1]) };
    m = t.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return type === "Comic" ? { chapter: parseFloat(m[1]) } : { episode: parseInt(m[1], 10) };
  }
  return { text: t };
}

export function samePoint(a, b) {
  if (!a || !b) return false;
  if (a.season != null || b.season != null) return a.season === b.season && a.episode === b.episode;
  if (a.episode != null || b.episode != null) return a.episode === b.episode;
  return a.chapter != null && a.chapter === b.chapter;
}

// Whether prog is at or past target (strict = strictly past).
export function pointReaches(prog, target, strict = false) {
  if (!prog || !target) return false;
  const cmp = (a, b) => (strict ? a > b : a >= b);
  if (target.season != null && prog.season != null) {
    return prog.season > target.season || (prog.season === target.season && cmp(prog.episode, target.episode));
  }
  if (target.episode != null && target.season == null && prog.episode != null) return cmp(prog.episode, target.episode);
  if (target.chapter != null && prog.chapter != null) return cmp(prog.chapter, target.chapter);
  return false;
}

// ---- numbers ----

// 12345 minutes -> "8d 13h" / "5h 45m" / "45m".
export function fmtDuration(minutes) {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.round(minutes % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtNumber(n) {
  return Number(n || 0).toLocaleString();
}

// Search normalization: case, spacing and punctuation are ignored, so
// "spider-man", "Spider Man" and "spiderman" all match.
export function normalizeSearch(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
