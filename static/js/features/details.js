// Entry details: read-only facts and group members. Actions live in the
// Ledger row menu.

import { API } from "../core/api.js";
import { h, icon, sequence } from "../core/dom.js";
import { getEntry, linkLabel, on, sourceLabel } from "../core/store.js";
import {
  fmtDate, fmtDuration, plural, progressText, samePoint, statusLabel, verbs,
} from "../core/format.js";
import {
  airingState, collectionRating, groupRating, groupStatus, includedMembers, isGroup, isStructural,
  isTerminal, kindType, membersOf, orderedMembers, posterOf, releaseStatusTone,
} from "../core/model.js";
import { openModal } from "../ui/modal.js";
import { poster } from "../ui/poster.js";
import { openRateDialog } from "./rate.js";

const STRUCTURE_TTL = 5 * 60 * 1000;
const structureMemo = new Map();
on("tracker-updated", () => structureMemo.clear());

function isTmdbShow(entry) {
  return entry.type === "Show" && (entry.link || {}).source === "tmdb_tv";
}

// Grouping-aware seasons for a TMDb show, shared briefly across opens.
function fetchStructure(entry) {
  const key = [entry.id, entry.link.id, entry.episode_group || ""].join("|");
  const hit = structureMemo.get(key);
  if (hit && Date.now() - hit.at < STRUCTURE_TTL) return hit.promise;
  const record = { at: Date.now() };
  record.promise = API.showStructure(entry.link.id, entry.episode_group, entry.id).catch(() => {
    if (structureMemo.get(key) === record) structureMemo.delete(key);
    return null;
  });
  structureMemo.set(key, record);
  return record.promise;
}

// Exact episodes through a point, or null when a season length is unknown
// (an uncertain total is never presented as exact).
function cumulativeEpisodes(seasons, point) {
  if (!point || point.season == null || point.episode == null) return null;
  const here = seasons.find((s) => s.number === point.season);
  if (!here) return null;
  if (typeof here.count === "number" && point.episode > here.count) return point.episode;
  let total = 0;
  for (const s of seasons) {
    if (s.number >= point.season) continue;
    if (typeof s.count !== "number") return null;
    total += s.count;
  }
  return total + point.episode;
}

function row(label, value) {
  if (value == null || value === "") return null;
  return h("div", { class: "details-row" }, h("dt", null, label), h("dd", null, value));
}

function sourceLinks(entry) {
  const links = [];
  if (entry.link) {
    const label = linkLabel(entry.link.source);
    links.push(entry.link.url
      ? h("a", { href: entry.link.url, target: "_blank", rel: "noopener noreferrer" }, label, icon("external", 12))
      : label);
  }
  const cl = entry.chapter_link;
  if (cl) {
    links.push(cl.url ? h("a", { href: cl.url, target: "_blank", rel: "noopener noreferrer" }, sourceLabel(cl.source), icon("external", 12))
      : sourceLabel(cl.source));
  }
  if (!links.length) return "Not linked";
  return h("span", { class: "details-links" }, links);
}

function progressRows(entry, details, refine) {
  const rows = [];
  const ended = airingState(details) === "ended";
  // A finished title that has ended says everything; "Stopped at" would be noise.
  const redundant = isStructural(entry.type) && entry.status === "finished" && ended;
  const text = progressText(entry.progress);
  if (text && !redundant) {
    const r = row(entry.status === "started" || entry.status === "finished" ? "Up to" : "Stopped at", text);
    rows.push(r);
    refine.progress = r;
  }
  const specials = (entry.specials_watched || []).length;
  if (specials) rows.push(row("Specials watched", String(specials)));
  const prev = entry.previous_watches || [];
  if (prev.length) {
    const finale = (p) => ended && (samePoint(p, entry.progress) ||
      (p && p.season == null && p.episode != null && typeof details.episodes === "number" && p.episode >= details.episodes));
    const [one, many] = verbs(entry.type).unit === "chapter" ? ["read", "reads"] : ["watch", "watches"];
    rows.push(row(`Previous ${prev.length === 1 ? one : many}`,
      prev.map((p) => (finale(p) ? "Finished" : `Up to ${progressText(p)}`)).join(", ")));
  }
  if (entry.rewatch_count) {
    rows.push(row(verbs(entry.type).repeated, plural(entry.rewatch_count, "time")));
  }
  return rows;
}

function factRows(entry, details, refine) {
  const book = ["Book", "Audiobook"].includes(entry.type);
  const rows = [
    row("Format", details.format),
    row("Author", details.author),
    row("Narrator", details.narrator),
    row(book ? "Published" : "Started", details.start_date && fmtDate(details.start_date)),
    row("Ended", details.end_date && fmtDate(details.end_date)),
  ];
  refine.seasons = row("Seasons", details.seasons != null ? String(details.seasons) : null);
  refine.episodes = row("Episodes", details.episodes != null ? String(details.episodes) : null);
  rows.push(refine.seasons, refine.episodes);
  refine.anchor = h("div", { class: "details-anchor", hidden: true });
  rows.push(refine.anchor);
  rows.push(row("Chapters", details.chapters != null ? String(details.chapters) : null));
  rows.push(row("Volumes", details.volumes != null ? String(details.volumes) : null));
  rows.push(row("Pages", details.pages != null ? String(details.pages) : null));
  if (details.runtime != null) {
    const audio = entry.type === "Audiobook";
    rows.push(row(audio ? "Length" : "Runtime", audio ? fmtDuration(details.runtime) : `${details.runtime} min`));
  }
  if (details.episode_runtime && entry.type === "Show") rows.push(row("Episode length", `${details.episode_runtime} min`));
  return rows;
}

function dateRows(entry) {
  const rows = [row("Added", fmtDate(entry.date_added))];
  if (isTerminal(entry.status)) {
    rows.push(row(entry.status === "dropped" ? "Dropped" : "Completed",
      entry.date_complete ? fmtDate(entry.date_complete) : "Unknown"));
  }
  return rows;
}

// Replace or insert a row once the grouping-aware structure arrives.
function refineStructure(entry, refine, token, seq) {
  if (!isTmdbShow(entry)) return;
  fetchStructure(entry).then((res) => {
    if (!seq.isCurrent(token) || !res || !Array.isArray(res.seasons) || !res.seasons.length) return;
    const setRow = (key, label, value) => {
      const next = row(label, value);
      if (refine[key]) refine[key].replaceWith(next);
      else refine.anchor.before(next);
      refine[key] = next;
    };
    setRow("seasons", "Seasons", String(res.seasons.length));
    const counts = res.seasons.map((s) => s.count);
    if (counts.every((c) => typeof c === "number")) {
      setRow("episodes", "Episodes", String(counts.reduce((a, b) => a + b, 0)));
    } else if (refine.episodes) {
      // An incomplete grouping must not leave the default total looking exact.
      refine.episodes.remove();
      refine.episodes = null;
    }
    const n = cumulativeEpisodes(res.seasons, entry.progress);
    if (refine.progress && n != null) {
      refine.progress.querySelector("dd").textContent = `${progressText(entry.progress)} (${plural(n, "episode")})`;
    }
  });
}

function memberList(group, modal) {
  if (group.collection) {
    const members = includedMembers(group);
    if (!members.length) return h("p", { class: "inline-note" }, "Membership hasn't loaded from the source yet.");
    return h("div", { class: "choice-list details-members" }, members.map((m) => {
      const rating = collectionRating(group, m.ref);
      return h("button", { type: "button", class: "choice", onClick: () => openRateDialog(group, m) },
        poster(m.thumb_url, { type: kindType(m.kind) }),
        h("span", { class: "choice-title" }, m.title || "Untitled"),
        h("span", { class: "choice-meta" }, (m.release_date || "").slice(0, 4)),
        rating != null ? h("span", { class: "stamp" }, rating) : h("span", { class: "rate-btn" }, "rate"));
    }));
  }
  const members = orderedMembers(membersOf(group.id), group.member_sort, group.member_order);
  if (!members.length) return h("p", { class: "inline-note" }, "No members yet — add some from Edit.");
  return h("div", { class: "choice-list details-members" }, members.map((m) =>
    h("button", { type: "button", class: "choice", onClick: () => { modal.close(); openDetails(m); } },
      poster(posterOf(m), { type: m.type }),
      h("span", { class: "choice-title" }, m.title),
      h("span", { class: `status status-${m.status}` }, statusLabel(m.status)),
      m.rating != null ? h("span", { class: "stamp" }, m.rating) : null)));
}

function render(entry, modal, seq) {
  const token = seq.next();
  const details = entry.details || {};
  const refine = {};
  const group = isGroup(entry);
  const members = group ? membersOf(entry.id) : [];
  const status = group ? groupStatus(entry, members) : entry.status;
  const rating = group ? groupRating(entry, members) : { value: entry.rating, own: true };

  // The source's own release status leads; the user's tags follow the header.
  const hero = h("div", { class: "details-hero" },
    poster(posterOf(entry), { size: "lg", type: entry.type }),
    h("div", { class: "details-heading" },
      h("h2", { class: "details-title" }, entry.title),
      entry.synonym ? h("div", { class: "details-synonym" }, entry.synonym) : null,
      details.status ? h("div", { class: `details-release release release-${releaseStatusTone(details.status)}` }, details.status) : null));
  const chips = h("div", { class: "details-chips" },
    h("span", { class: "tag" }, entry.type),
    status ? h("span", { class: `status status-${status}` }, statusLabel(status)) : null,
    rating.value != null ? h("span", { class: ["stamp", !rating.own && "derived"],
      title: rating.own ? `Rated ${rating.value}/10` : "Average of the members' ratings" }, rating.value) : null,
    entry.hidden ? h("span", { class: "tag" }, icon("eyeOff", 12), "Hidden") : null,
    entry.ignored ? h("span", { class: "tag" }, "Ignored in Tracker") : null);

  const info = h("dl", { class: "details-grid" },
    row("Source", sourceLinks(entry)),
    row("Synonym", entry.synonym || null),
    ...(group ? [] : progressRows(entry, details, refine)),
    ...factRows(entry, details, refine),
    ...dateRows(entry));

  modal.setTitle(group ? "Group" : entry.type);
  modal.setContent(
    hero,
    chips,
    group ? h("div", null, h("h3", { class: "section-heading" }, entry.collection ? "In this collection" : "Members"), memberList(entry, modal)) : null,
    info,
    entry.notes ? h("div", { class: "details-notes" }, h("h3", { class: "section-heading" }, "Notes"), h("p", null, entry.notes)) : null);
  refineStructure(entry, refine, token, seq);
}

export function openDetails(entryOrId) {
  const id = typeof entryOrId === "string" ? entryOrId : entryOrId.id;
  const seq = sequence();
  let unsubscribe = () => {};
  const modal = openModal({ className: "details-modal", onClose: () => { seq.invalidate(); unsubscribe(); } });
  const draw = () => {
    const entry = getEntry(id);
    if (!entry) return modal.close();
    render(entry, modal, seq);
  };
  unsubscribe = on("entries", draw);
  draw();
  return modal;
}
