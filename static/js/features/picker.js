// Episode / chapter picker, shared by the entry form and the Tracker.
//
// pickProgress(opts) resolves one of:
//   { kind: "point", point, label, finale }   an episode/chapter was chosen
//   { kind: "specials", refs }                 specials ticked, then Done
//   { kind: "ahead", point }                   (strict) a chapter past the
//                                              latest, confirmed as the new latest
//   null                                       dismissed
//
// The single bulk shortcut always targets the real latest aired/released
// point, never a season's nominal count; only its label depends on whether
// the show has ended.

import { API } from "../core/api.js";
import { clear, h, sequence } from "../core/dom.js";
import { getEntry } from "../core/store.js";
import { fmtDateShort, parseProgress, progressText, todayISO } from "../core/format.js";
import { confirm, openModal } from "../ui/modal.js";
import { toast, toastError } from "../ui/toast.js";
import { markProgress, patchWithUndo, setSpecials } from "./actions.js";
import { fixLatestChapter } from "./comic-source.js";
import { dropdown } from "../ui/dropdown.js";

function bulkTarget(ctx) {
  if (ctx.mode === "tmdb") {
    const la = ctx.lastAired;
    if (!la || la.season == null) return null;
    return { point: { season: la.season, episode: la.episode }, label: `S${la.season}E${la.episode}`,
      complete: !ctx.nextAir && !ctx.inProduction };
  }
  // A single planned total says nothing about what has been released, so
  // these always read "Catch up".
  if (ctx.mode === "abs") return ctx.count ? { point: { episode: ctx.count }, label: `Ep ${ctx.count}` } : null;
  return ctx.latest != null ? { point: { chapter: ctx.latest }, label: `Ch ${ctx.latest}` } : null;
}

function isFinale(ctx, point) {
  if (!point || !ctx.complete) return false;
  const target = bulkTarget(ctx);
  if (!target) return false;
  const t = target.point;
  return t.season != null ? point.season === t.season && point.episode === t.episode
    : t.episode != null ? point.episode === t.episode : point.chapter === t.chapter;
}

function episodeRow(title, meta, overview, { selected, disabled, onClick } = {}) {
  return h("button", { type: "button", class: ["pick-row", selected && "selected"], disabled: !!disabled, onClick },
    h("span", { class: "pick-row-title" }, title),
    meta ? h("span", { class: "pick-row-meta" }, meta) : null,
    overview ? h("span", { class: "pick-row-overview" }, overview) : null);
}

function hintFor(ctx, specials) {
  if (specials) return "Tap each special you've watched — they're counted separately from the main run.";
  if (ctx.locked) return "Everything's watched — tick any specials you saw, or change the grouping.";
  if (ctx.forRewatch) {
    const target = bulkTarget(ctx);
    const unit = ctx.mode === "chapter" ? "chapter you read" : "episode you watched";
    return `Tap the last ${unit} that time — or ${target && target.complete ? "Watched it all" : "Catch up"}.`;
  }
  return ctx.mode === "chapter"
    ? "Tap a chapter to mark everything up to and including it as read."
    : "Tap an episode to mark everything up to and including it as watched.";
}

// ---------------------------------------------------------------- strict manual entry

function manualEpisode(ctx, raw) {
  const se = raw.match(/^s\s*(\d+)\s*e\s*(\d+)$/i);
  const ep = se ? null : raw.match(/^(?:e|ep|episode)\.?\s*(\d+)$/i) || raw.match(/^(\d+)$/);
  if (!se && !ep) return { error: "Use S2E5, E12, or a plain episode number." };
  if (ctx.mode === "abs") {
    if (se && Number(se[1]) !== 1) return { error: "This show numbers episodes without seasons — use E12 or 12." };
    const n = Number(se ? se[2] : ep[1]);
    if (n < 1 || (ctx.count && n > ctx.count)) {
      return { error: `Episode ${n} doesn't exist${ctx.count ? ` — only ${ctx.count} listed` : ""}.` };
    }
    return { point: { episode: n } };
  }
  const count = (s) => {
    const c = ctx.counts[String(s)];
    return typeof c === "number" && c > 0 ? c : null;
  };
  const la = ctx.lastAired;
  // Continuous numbering (One Piece): episode numbers run past a season's count.
  const continuous = !!(la && la.season != null && count(la.season) != null && la.episode > count(la.season));
  const seasons = ctx.seasons.map((s) => s.number);
  if (se) {
    const s = Number(se[1]), e = Number(se[2]);
    if (seasons.length && !seasons.includes(s)) return { error: `Season ${s} doesn't exist.` };
    const c = count(s);
    if (c != null) {
      if (continuous) {
        let end = 0;
        for (const x of seasons) {
          if (count(x) == null) { end = null; break; }
          end += count(x);
          if (x === s) break;
        }
        if (end != null && (e < end - c + 1 || e > end)) return { error: `Season ${s} covers E${end - c + 1}–E${end}.` };
      } else if (e < 1 || e > c) {
        return { error: `Season ${s} only has ${c} episodes.` };
      }
    }
    return { point: { season: s, episode: e } };
  }
  // A bare number counts from the very first episode.
  const n = Number(ep[1]);
  if (n < 1) return { error: `Episode ${n} doesn't exist.` };
  let total = 0;
  for (const s of seasons) {
    const c = count(s);
    if (c == null) return { error: "Episode counts unknown — type it as S#E# instead." };
    if (n <= total + c) return { point: { season: s, episode: continuous ? n : n - total } };
    total += c;
  }
  if (continuous && la && n <= la.episode) return { point: { season: la.season, episode: n } };
  return { error: `Episode ${n} doesn't exist — ${total ? `only ${total} listed` : "check the number"}.` };
}

async function manualChapter(ctx, raw) {
  const m = raw.match(/^(?:ch|chapter)\.?\s*(\d+(?:\.\d+)?)$/i) || raw.match(/^(\d+(?:\.\d+)?)$/);
  if (!m) return { error: "Use a chapter number, e.g. 34 or Ch 34." };
  const n = Number(m[1]);
  // Past the tracked latest, or no latest at all: offer to make it the latest.
  if (ctx.latest == null || n > ctx.latest) {
    const known = ctx.latest != null;
    const ok = await confirm({
      title: known ? "Ahead of the latest chapter" : "Set the latest chapter?",
      message: known
        ? `The latest tracked chapter is Ch ${ctx.latest}. Mark Ch ${n} read and make it the latest chapter?`
        : `No latest chapter is tracked yet. Mark Ch ${n} read and use it as the latest chapter?`,
      confirmLabel: "Set both",
    });
    return ok ? { ahead: { chapter: n } } : { cancelled: true };
  }
  return { point: { chapter: n } };
}

// ---------------------------------------------------------------- grouping

async function chooseEpisodeGrouping(tmdbId, currentGroup) {
  let selected = currentGroup || null;
  const list = h("div", { class: "choice-list grouping-list" }, h("p", { class: "loading" }, "Loading…"));
  const modal = openModal({
    title: "Episode grouping",
    content: [h("p", { class: "modal-message muted" },
      "Choose how this show's episodes are grouped into seasons — some groupings fold specials into the season they aired with."), list],
    actions: [{ label: "Cancel", value: undefined }, { label: "Apply", kind: "primary", onClick: (m) => m.close(selected) }],
  });
  try {
    const { groups } = await API.showGroups(tmdbId);
    if (modal.closed) return modal.result;
    list.replaceChildren(...[{ id: null, name: "Default (TMDb seasons)" }, ...groups].map((g) => {
      const meta = [g.type_label, g.group_count && `${g.group_count} sn`, g.episode_count && `${g.episode_count} ep`].filter(Boolean).join(" · ");
      const btn = h("button", { type: "button", class: ["choice", (g.id || null) === selected && "selected"], title: g.description || "" },
        h("span", { class: "choice-title" }, g.name), meta ? h("span", { class: "choice-meta" }, meta) : null);
      btn.addEventListener("click", () => {
        selected = g.id || null;
        list.querySelectorAll(".choice").forEach((c) => c.classList.toggle("selected", c === btn));
      });
      return btn;
    }));
  } catch (err) {
    list.replaceChildren(h("p", { class: "inline-note" }, err.message));
  }
  return modal.result;
}

// ---------------------------------------------------------------- picker

export function pickProgress(opts) {
  const ctx = { seasons: [], counts: {}, lastAired: null, nextAir: null, inProduction: false, hasSpecials: false,
    ...opts, specialsTicked: new Set(opts.specials || []) };
  const seq = sequence();
  let view = null; // season number | "specials"

  const hint = h("p", { class: "pick-hint" });
  const groupingBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", hidden: true, onClick: changeGrouping }, "Change grouping");
  const seasonSelect = h("select", { class: "select", "aria-label": "Season" });
  const rangeSelect = h("select", { class: "select", "aria-label": "Chapters" });
  const bulkBtn = h("button", { type: "button", class: "btn btn-ghost", hidden: true });
  const list = h("div", { class: "pick-list" });
  const specialsCount = h("span", { class: "muted" });
  const specialsBar = h("div", { class: "pick-specials-bar", hidden: true }, specialsCount,
    h("button", { type: "button", class: "btn btn-primary btn-sm",
      onClick: () => modal.close({ kind: "specials", refs: [...ctx.specialsTicked] }) }, "Done"));
  const manualInput = h("input", { class: "input", type: "text", autocomplete: "off",
    placeholder: ctx.mode === "chapter" ? "or type it (e.g. Ch 34)" : "or type it (e.g. S2E5 · 12)" });
  const manualRow = h("form", { class: "inline-row pick-manual", onSubmit: (e) => { e.preventDefault(); submitManual(); } },
    manualInput, h("button", { type: "submit", class: "btn btn-ghost" }, "Set"));

  const modal = openModal({
    title: ctx.title || "Set progress", size: "md", className: "picker-modal", autofocus: false,
    content: [h("div", { class: "pick-top" }, hint, groupingBtn),
      h("div", { class: "pick-controls" }, dropdown(seasonSelect), dropdown(rangeSelect), bulkBtn), list, specialsBar, manualRow],
  });

  const choosePoint = (point, label) =>
    modal.close({ kind: "point", point, label: label || progressText(point), finale: isFinale(ctx, point) });

  function message(text, extra) {
    clear(list, h("p", { class: "inline-note pick-message" }, text), extra);
  }

  function renderBulk() {
    const target = !ctx.locked && view !== "specials" ? bulkTarget(ctx) : null;
    bulkBtn.hidden = !target;
    if (!target) return;
    bulkBtn.textContent = target.complete ? "Watched it all" : `Catch up (${target.label})`;
    bulkBtn.onclick = () => choosePoint(target.point, target.label);
  }

  function renderChrome() {
    const specials = view === "specials";
    hint.textContent = hintFor(ctx, specials);
    seasonSelect.hidden = ctx.mode !== "tmdb";
    rangeSelect.hidden = ctx.mode !== "chapter" || !(ctx.latest > 50);
    groupingBtn.hidden = ctx.mode !== "tmdb" || !ctx.onGrouping;
    specialsBar.hidden = !specials;
    manualRow.hidden = specials || !!ctx.locked;
    specialsCount.textContent = ctx.specialsTicked.size ? `${ctx.specialsTicked.size} selected` : "None selected";
    renderBulk();
  }

  // ---- TMDb ----

  function buildSeasonOptions() {
    const seasons = ctx.seasons.length ? ctx.seasons : [{ number: 1 }];
    clear(seasonSelect, seasons.map((s) => h("option", { value: s.number }, `Season ${s.number}`)),
      ctx.hasSpecials && ctx.specials ? h("option", { value: "specials" }, "Specials") : null);
    const def = ctx.locked && ctx.hasSpecials && ctx.specials ? "specials"
      : (ctx.progress && ctx.progress.season) || (ctx.lastAired && ctx.lastAired.season) || seasons[0].number;
    seasonSelect.value = String(def);
    if (!seasonSelect.value) seasonSelect.selectedIndex = 0;
  }

  async function loadStructure() {
    const token = seq.next();
    message("Loading…");
    try {
      const st = ctx.structure || await API.showStructure(ctx.tmdbId, ctx.episodeGroup, ctx.entryId);
      ctx.structure = null;
      if (!seq.isCurrent(token) || modal.closed) return;
      ctx.seasons = st.seasons || [];
      ctx.counts = Object.fromEntries(ctx.seasons.map((s) => [String(s.number), s.count]));
      ctx.lastAired = st.last_aired || null;
      ctx.nextAir = st.next_air || null;
      ctx.inProduction = !!st.in_production;
      ctx.hasSpecials = !!st.has_specials;
      ctx.complete = !ctx.nextAir && !ctx.inProduction;
      if (ctx.followLatest && ctx.lastAired) ctx.progress = { season: ctx.lastAired.season, episode: ctx.lastAired.episode };
      buildSeasonOptions();
      loadSeason();
    } catch (err) {
      if (seq.isCurrent(token)) message(err.message);
    }
  }

  async function loadSeason() {
    view = seasonSelect.value === "specials" ? "specials" : Number(seasonSelect.value);
    renderChrome();
    const token = seq.next();
    message("Loading…");
    try {
      const { episodes } = await API.showSeason(ctx.tmdbId, view, ctx.episodeGroup);
      if (!seq.isCurrent(token) || modal.closed) return;
      if (view === "specials") renderSpecials(episodes);
      else renderSeason(view, episodes);
    } catch (err) {
      if (seq.isCurrent(token)) message(err.message);
    }
  }

  function renderSeason(season, episodes) {
    if (!episodes.length) return message("No episodes listed for this season yet.");
    const today = todayISO();
    const p = ctx.progress || {};
    list.replaceChildren(...episodes.map((ep) => {
      const watched = p.season != null && (season < p.season || (season === p.season && ep.episode <= p.episode));
      const label = `S${season}E${ep.episode}`;
      return episodeRow(ep.name || `Episode ${ep.episode}`, `${label} · ${ep.air_date ? fmtDateShort(ep.air_date) : "TBA"}`, ep.overview, {
        selected: ctx.locked || watched,
        disabled: ctx.locked || !ep.air_date || ep.air_date > today,
        onClick: () => choosePoint({ season, episode: ep.episode }, label),
      });
    }));
    const watched = list.querySelectorAll(".selected");
    const current = watched[watched.length - 1];
    if (current && !ctx.locked) requestAnimationFrame(() => current.scrollIntoView({ block: "nearest" }));
  }

  function renderSpecials(episodes) {
    if (!episodes.length) return message("No specials listed.");
    list.replaceChildren(...episodes.map((ep) => {
      const row = episodeRow(ep.name || `Special ${ep.episode}`, `E${ep.episode} · ${ep.air_date ? fmtDateShort(ep.air_date) : "TBA"}`,
        ep.overview, { selected: ctx.specialsTicked.has(ep.ref) });
      row.addEventListener("click", () => {
        if (ctx.specialsTicked.has(ep.ref)) ctx.specialsTicked.delete(ep.ref);
        else ctx.specialsTicked.add(ep.ref);
        row.classList.toggle("selected");
        renderChrome();
      });
      return row;
    }));
  }

  async function changeGrouping() {
    const next = await chooseEpisodeGrouping(ctx.tmdbId, ctx.episodeGroup);
    if (next === undefined || (next || null) === (ctx.episodeGroup || null) || modal.closed) return;
    try {
      const res = await ctx.onGrouping(next || null);
      if (modal.closed) return;
      ctx.episodeGroup = next || null;
      if (res && "progress" in res) ctx.progress = res.progress;
      loadStructure();
    } catch (err) {
      toastError(err);
    }
  }

  // ---- AniList (absolute episodes) ----

  function renderAbs() {
    renderChrome();
    if (!ctx.count) {
      return message(ctx.locked ? "Everything's watched." : "Episode count unknown — you can still type the episode below.");
    }
    const cur = ctx.progress && ctx.progress.episode != null ? ctx.progress.episode : null;
    list.replaceChildren(...Array.from({ length: ctx.count }, (_, i) => i + 1).map((n) =>
      episodeRow(`Episode ${n}`, null, null, { selected: ctx.locked || (cur != null && n <= cur), disabled: ctx.locked,
        onClick: () => choosePoint({ episode: n }) })));
  }

  // ---- chapters ----

  function buildRanges() {
    renderChrome();
    if (ctx.latest == null || ctx.latest < 1) {
      const fix = ctx.onFixLatest ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: async () => {
        const value = await ctx.onFixLatest(ctx.latest);
        if (typeof value === "number" && !modal.closed) {
          ctx.latest = value;
          buildRanges();
        }
      } }, "Fix latest chapter") : null;
      return message("Latest chapter unknown — you can still type the chapter you've read below.", fix);
    }
    const top = Math.floor(ctx.latest);
    const ranges = [];
    for (let start = 1; start <= top; start += 50) ranges.push([start, Math.min(start + 49, top)]);
    rangeSelect.replaceChildren(...ranges.map(([a, b]) => h("option", { value: a }, `${a}–${b}`)));
    const cur = ctx.progress && ctx.progress.chapter != null ? Math.floor(ctx.progress.chapter) : top;
    rangeSelect.value = String(Math.floor((Math.min(Math.max(cur, 1), top) - 1) / 50) * 50 + 1);
    renderChapters();
  }

  function renderChapters() {
    const latest = ctx.latest;
    const top = Math.floor(latest);
    const start = Number(rangeSelect.value) || 1;
    const end = Math.min(start + 49, top);
    const cur = ctx.progress && ctx.progress.chapter != null ? ctx.progress.chapter : null;
    const cell = (n) => h("button", { type: "button", class: ["pick-cell", cur != null && n <= cur && "selected"],
      onClick: () => choosePoint({ chapter: n }) }, `Ch ${n}`);
    const cells = [];
    for (let n = start; n <= end; n++) cells.push(cell(n));
    // A fractional latest chapter (34.5) is its own final cell.
    if (latest > top && end >= top) cells.push(cell(latest));
    list.replaceChildren(h("div", { class: "pick-grid" }, cells));
  }

  async function submitManual() {
    const raw = manualInput.value.trim();
    if (!raw) return;
    if (!ctx.strict) return modal.close({ kind: "point", point: parseProgress(raw, ctx.mode === "chapter" ? "Comic" : "Show"), label: raw, finale: false });
    const res = ctx.mode === "chapter" ? await manualChapter(ctx, raw) : manualEpisode(ctx, raw);
    if (res.error) return toast(res.error);
    if (res.ahead) return modal.close({ kind: "ahead", point: res.ahead });
    if (res.point) choosePoint(res.point);
  }

  seasonSelect.addEventListener("change", loadSeason);
  rangeSelect.addEventListener("change", renderChapters);

  if (ctx.mode === "tmdb") loadStructure();
  else if (ctx.mode === "abs") renderAbs();
  else {
    buildRanges();
    if (ctx.latest == null && ctx.latestFallback) {
      ctx.latestFallback().then((latest) => {
        if (latest != null && !modal.closed && ctx.latest == null) {
          ctx.latest = latest;
          buildRanges();
        }
      });
    }
  }
  return modal.result.then((r) => r || null);
}

// ---------------------------------------------------------------- tracker entry point

// Switch a saved show's grouping, remapping progress and earlier watches to
// the new numbering (same physical episode first; unresolvable points keep
// their raw numbers).
async function regroup(entry, tmdbId, newGroup) {
  const points = [];
  const refs = [];
  if (entry.progress && entry.progress.season != null) { refs.push("progress"); points.push(entry.progress); }
  (entry.previous_watches || []).forEach((p, i) => {
    if (p && p.season != null) { refs.push(i); points.push(p); }
  });
  let mapped = points.map(() => null);
  if (points.length) {
    try { mapped = (await API.remap(tmdbId, entry.episode_group || null, newGroup, points)).points || mapped; } catch (_) { /* keep raw */ }
  }
  let progress = entry.progress || null;
  const previous = (entry.previous_watches || []).slice();
  refs.forEach((ref, i) => {
    if (!mapped[i]) return;
    if (ref === "progress") progress = mapped[i];
    else previous[ref] = mapped[i];
  });
  const result = await patchWithUndo(entry, { episode_group: newGroup, progress, previous_watches: previous },
    "Episode grouping updated.", { kind: "grouping" });
  if (!result) throw new Error("The grouping wasn't changed.");
  return { progress };
}

export async function pickForItem(item) {
  const entry = getEntry(item.id);
  if (!entry) return;
  const base = { title: item.title, progress: item.progress, strict: true };
  let opts;
  if (item.kind === "tmdb_tv") {
    const counts = item.episode_counts || {};
    opts = { ...base, mode: "tmdb", tmdbId: item.external_id, episodeGroup: item.episode_group, entryId: item.id,
      specials: item.specials_watched || [],
      structure: item.seasons && item.seasons.length ? {
        seasons: item.seasons.map((n) => ({ number: n, count: counts[String(n)] })), last_aired: item.last_aired,
        next_air: item.next_air, in_production: item.in_production, has_specials: item.has_specials,
      } : null,
      onGrouping: (group) => regroup(getEntry(item.id), item.external_id, group) };
  } else if (item.kind === "anilist_show") {
    opts = { ...base, mode: "abs", count: item.last_aired_ep };
  } else {
    opts = { ...base, mode: "chapter", latest: item.latest_chapter,
      onFixLatest: () => fixLatestChapter(getEntry(item.id), item) };
  }
  const result = await pickProgress(opts);
  const current = getEntry(item.id);
  if (!result || !current) return;
  if (result.kind === "point") {
    await markProgress(current, result.point, `Marked up to ${result.label}.`);
  } else if (result.kind === "specials") {
    await setSpecials(current, result.refs);
  } else if (result.kind === "ahead") {
    const n = result.point.chapter;
    await patchWithUndo(current, { progress: result.point, chapter_override: n },
      `Read up to Ch ${n} — latest set to Ch ${n} (custom).`, { kind: "progress" });
  }
}
