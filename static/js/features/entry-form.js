// Add / Edit entry form. "Everything" is only a display label: the real
// finale is stored. Blank progress on a finished, ended Show is the
// deliberate "untracked in Stats" state.

import { API } from "../core/api.js";
import { append, clear, debounce, h, icon, iconButton, sequence } from "../core/dom.js";
import {
  applyResult, defaultSourceFor, hasAltTitles, prefs, setEntries, searchSourceForLink, secondarySource, sourceInfo,
  sourceLabel, sources, linkLabel, state, trackerItem,
} from "../core/store.js";
import {
  STATUS_LABELS, TYPES, parseProgress, typeOrder, pointReaches, progressText, samePoint, statusLabel, todayISO, verbs,
} from "../core/format.js";
import { airingState, isGroup, isStructural, isTerminal } from "../core/model.js";
import { choose, confirm, onEscape, openModal } from "../ui/modal.js";
import { toast, toastError } from "../ui/toast.js";
import { poster } from "../ui/poster.js";
import { deleteEntry } from "./actions.js";
import { ratingScale } from "./rate.js";
import { pickProgress } from "./picker.js";
import { openTitleOptions } from "./titles.js";
import { pickChapterSource, promptLatestChapter } from "./comic-source.js";
import { groupEditor } from "./group-editor.js";
import { dropdown } from "../ui/dropdown.js";

const EVERYTHING_RE = /^(everything|all)$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function field(label, control, { hint, className } = {}) {
  return h("label", { class: ["field", className] },
    h("span", { class: "field-label" }, label, hint ? h("span", { class: "hint" }, ` ${hint}`) : null), control);
}

function select(options, value) {
  return h("select", { class: "select" }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

// prefill ({ title, type, notes, status }) seeds a new entry, e.g. from the Stash.
export function openEntryForm(existing, prefill = {}) {
  const editing = !!existing;
  const e = existing || {};
  const knownType = (t) => !!t && t !== "Group" && (TYPES.includes(t) || state.entries.some((x) => x.type === t));
  const f = {
    type: e.type || (knownType(prefill.type) ? prefill.type
      : TYPES.includes(prefs.get("form.lastType")) || prefs.get("form.lastType") === "Group" ? prefs.get("form.lastType") : "Show"),
    link: e.link ? { ...e.link, details: e.details, thumb_url: null, title: null } : null,
    linkChanged: false,
    synonym: e.synonym || null,
    statusTouched: editing || !!prefill.status,
    untracked: editing && e.type === "Show" && e.status === "finished" && !e.progress,
    prevRest: (e.previous_watches || []).slice(1),
    chapterLink: e.chapter_link || null,
    chapterOverride: e.chapter_override ?? null,
    episodeGroup: e.episode_group || null,
    specials: (e.specials_watched || []).slice(),
    // The link the media-specific values below belong to.
    stateLink: e.link ? `${e.link.source}:${e.link.id}` : null,
    showEnd: null,
    revealed: new Set(),
    submitting: false,
    collectionGroup: null,
  };
  const searchSeq = sequence();
  const pickSeq = sequence();
  const endSeq = sequence();

  // ---------------------------------------------------------------- controls

  const customTypes = [...new Set(state.entries.map((x) => x.type))].filter((t) => !TYPES.includes(t) && t !== "Group");
  const typeSelect = select(typeOrder(customTypes).map((t) => [t, t]), f.type);
  const sourceSelect = h("select", { class: "select" });
  const titleInput = h("input", { class: "input", type: "text", value: e.title || prefill.title || "", autocomplete: "off",
    placeholder: "Search or type a title", required: true });
  const titleEdit = h("button", { type: "button", class: "btn btn-ghost", onClick: editTitles }, "Edit…");
  const suggest = h("div", { class: "suggest", hidden: true, role: "listbox" });
  const linkChip = h("div", { class: "link-chip", hidden: true });
  const chapterChip = h("div", { class: "link-chip", hidden: true });

  const dateAddedInput = h("input", { class: "input", type: "date" });
  const dateAddedRaw = h("input", { class: "input", type: "text", placeholder: "or paste 2024-05-23T15:12:03Z", autocomplete: "off" });
  const dateAddedField = h("div", { class: "field", hidden: editing || !state.config.allow_custom_date_added },
    h("span", { class: "field-label" }, "Date added", h("span", { class: "hint" }, " (for backfilling — blank uses today)")),
    h("div", { class: "field-row pair" }, dateAddedInput, dateAddedRaw));

  const statusSelect = select(Object.entries(STATUS_LABELS), e.status || "started");
  const statusField = field("Status", dropdown(statusSelect));
  const dateCompleteInput = h("input", { class: "input", type: "date", value: e.date_complete || "" });
  const dateCompleteLabel = h("span", { class: "field-label" }, "Date completed");
  const unknownDate = h("input", { type: "checkbox", checked: editing && e.status === "finished" && !e.date_complete });
  const dateCompleteField = h("div", { class: "field" }, dateCompleteLabel, dateCompleteInput,
    h("label", { class: "check" }, unknownDate, "Unknown date"));
  const statusRow = h("div", { class: "field-row pair" }, statusField, dateCompleteField);

  const progressInput = h("input", { class: "input", type: "text", autocomplete: "off",
    value: e.progress ? (e.progress.text || progressText(e.progress)) : "" });
  const progressPick = h("button", { type: "button", class: "btn btn-ghost", onClick: () => openPicker("progress") }, "Pick…");
  const progressLabel = h("span", { class: "field-label" });
  const everythingBtn = h("button", { type: "button", class: "everything-btn", onClick: onEverythingClick });
  const untrackBtn = h("button", { type: "button", class: "btn btn-ghost", onClick: untrack }, "Untrack");
  const specialsNote = h("span", { class: "field-note", hidden: true });
  const progressInputRow = h("div", { class: "inline-row" }, progressInput, progressPick);
  const progressStatusRow = h("div", { class: "inline-row", hidden: true }, everythingBtn, untrackBtn);
  const progressField = h("div", { class: "field" }, progressLabel, progressInputRow, progressStatusRow, specialsNote);

  const rewatchInput = h("input", { class: "input", type: "text", autocomplete: "off",
    value: (e.previous_watches || [])[0] ? progressText(e.previous_watches[0]) : "" });
  const rewatchPick = h("button", { type: "button", class: "btn btn-ghost", onClick: () => openPicker("rewatch") }, "Pick…");
  const rewatchLabel = h("span", { class: "field-label" });
  const rewatchField = h("div", { class: "field" }, rewatchLabel,
    h("div", { class: "inline-row" }, rewatchInput, rewatchPick,
      iconButton("close", "Remove", () => { rewatchInput.value = ""; f.revealed.delete("rewatch"); f.hasRewatch = false; sync(); })));

  const countInput = h("input", { class: "input count-input", type: "number", min: 0, step: 1, inputmode: "numeric",
    value: e.rewatch_count || 1 });
  const countLabel = h("span", { class: "field-label" });
  const countField = h("div", { class: "field" }, countLabel,
    h("div", { class: "inline-row stepper" },
      h("button", { type: "button", class: "btn btn-ghost", onClick: () => bump(-1) }, "−"), countInput,
      h("button", { type: "button", class: "btn btn-ghost", onClick: () => bump(1) }, "+"),
      iconButton("close", "Remove", () => { f.hasCount = false; sync(); })));
  f.hasRewatch = !!(e.previous_watches || []).length;
  f.hasCount = !!e.rewatch_count;

  let rating = e.rating ?? null;
  const ratingHolder = h("div");
  const ratingField = h("div", { class: "field" }, h("span", { class: "field-label" }, "Rating"), ratingHolder);
  const notesInput = h("textarea", { class: "input", rows: 3 }, e.notes || prefill.notes || "");
  const notesField = field("Notes", notesInput);

  const hiddenCheck = h("input", { type: "checkbox", checked: !!e.hidden });
  const ignoredCheck = h("input", { type: "checkbox", checked: !!e.ignored });
  const ignoredLabel = h("label", { class: "check" }, ignoredCheck, "Ignore in Tracker");
  const collectionCheck = h("input", { type: "checkbox" });
  const collectionSuggest = h("label", { class: "check collection-suggest", hidden: true }, collectionCheck, h("span"));

  const adders = h("div", { class: "adders" });
  const group = groupEditor({ entry: isGroup(existing) ? existing : null, getLink: () => f.link,
    getTitle: () => titleInput.value.trim(), onChange: () => sync() });

  // ---------------------------------------------------------------- helpers

  const type = () => typeSelect.value;
  const status = () => statusSelect.value;
  const structural = () => isStructural(type());
  const linkDetails = () => (f.link && f.link.details) || {};
  const isTmdbShow = () => type() === "Show" && f.link && f.link.source === "tmdb_tv";
  const airing = () => airingState(linkDetails());
  const finishedEnded = () => type() === "Show" && status() === "finished" && airing() !== "airing";
  const collectionMode = () => isGroup({ type: type() }) && group.state.collection;
  const tracked = () => editing && trackerItem(e.id);

  function bump(delta) {
    countInput.value = String(Math.max(0, (parseInt(countInput.value, 10) || 0) + delta));
  }

  // The latest aired AniList episode. An announced total only counts once the
  // show has ended; the tracker's aired count applies only to the saved link.
  function episodeCount() {
    const item = !f.linkChanged && tracked();
    if (item && item.last_aired_ep > 0) return item.last_aired_ep;
    const d = linkDetails();
    return airing() === "ended" && typeof d.episodes === "number" && d.episodes > 0 ? d.episodes : null;
  }

  // The latest chapter without the override (callers apply it first, matching
  // the Tracker): AniList's count, then the tracker's cached latest, which
  // describes only the saved link and chapter source.
  function chapterCount() {
    const d = linkDetails();
    if (typeof d.chapters === "number" && d.chapters > 0) return d.chapters;
    const sameChapterSource = JSON.stringify(f.chapterLink || null) === JSON.stringify(e.chapter_link || null);
    const item = !f.linkChanged && sameChapterSource && tracked();
    return item && item.latest_chapter != null ? item.latest_chapter : null;
  }

  async function liveChapterLatest() {
    const cl = f.chapterLink;
    if (!cl) return null;
    try {
      const res = await API.comicLatest(cl.source, cl.id);
      return res.latest ?? null;
    } catch (_) {
      return null;
    }
  }

  let structureMemo = null;
  function showStructure() {
    const key = `${f.link.id}|${f.episodeGroup || ""}`;
    if (structureMemo && structureMemo.key === key) return structureMemo.promise;
    const promise = API.showStructure(f.link.id, f.episodeGroup, editing ? e.id : null);
    structureMemo = { key, promise };
    promise.catch(() => { if (structureMemo && structureMemo.promise === promise) structureMemo = null; });
    return promise;
  }

  function pickAvailable() {
    if (!f.link) return false;
    if (isTmdbShow()) return true;
    if (type() === "Show" && f.link.source === "anilist") return !!episodeCount();
    return type() === "Comic";
  }

  // ---------------------------------------------------------------- Everything

  async function resolveShowEnd() {
    const token = endSeq.next();
    let point = null;
    try {
      if (isTmdbShow()) {
        const st = await showStructure();
        if (st.last_aired && st.last_aired.season != null) point = { season: st.last_aired.season, episode: st.last_aired.episode };
      } else if (type() === "Show" && episodeCount()) {
        point = { episode: episodeCount() };
      }
    } catch (_) { /* finale stays unknown */ }
    if (!endSeq.isCurrent(token)) return;
    f.showEnd = { complete: airing() !== "airing", point, label: point ? progressText(point) : null };
    if (finishedEnded() && !f.untracked && !progressInput.value.trim() && f.showEnd.label) {
      progressInput.value = f.showEnd.label;
    }
    refreshProgressDisplay();
  }

  function refreshProgressDisplay() {
    const ended = finishedEnded();
    progressInputRow.hidden = ended;
    progressStatusRow.hidden = !ended;
    if (ended) {
      const untracked = f.untracked || !progressInput.value.trim();
      const value = progressInput.value.trim();
      const shown = value && !EVERYTHING_RE.test(value) ? value : (f.showEnd && f.showEnd.label) || "";
      everythingBtn.textContent = untracked ? "Not tracked" : shown ? `Everything (${shown})` : "Everything";
      everythingBtn.title = untracked ? "Restore Everything and count this show in Stats" : "Open the finished-show picker";
      untrackBtn.hidden = untracked;
    }
    // A full-run rewatch of an ended show reads "Everything" too.
    if (f.showEnd && f.showEnd.complete && f.showEnd.point) {
      const rw = parseProgress(rewatchInput.value, type());
      if (rw && !rw.text && samePoint(rw, f.showEnd.point)) rewatchInput.value = "Everything";
    }
  }

  async function onEverythingClick() {
    if (f.untracked || !progressInput.value.trim()) {
      f.untracked = false;
      if (f.showEnd && f.showEnd.label) {
        progressInput.value = f.showEnd.label;
        refreshProgressDisplay();
      } else {
        await resolveShowEnd();
      }
      return;
    }
    openPicker("progress");
  }

  function untrack() {
    progressInput.value = "";
    f.untracked = true;
    refreshProgressDisplay();
  }

  // Turn a literal "Everything"/"All" into the real finale before saving.
  async function resolveEverything(raw) {
    if (!structural() || !EVERYTHING_RE.test((raw || "").trim())) return raw;
    try {
      if (isTmdbShow()) {
        const st = await showStructure();
        if (st.last_aired && st.last_aired.season != null) return `S${st.last_aired.season}E${st.last_aired.episode}`;
      } else if (type() === "Show") {
        if (episodeCount()) return `Ep ${episodeCount()}`;
      } else {
        const c = f.chapterOverride ?? chapterCount();
        if (c != null) return `Ch ${c}`;
      }
    } catch (_) { /* keep the text */ }
    return raw;
  }

  // ---------------------------------------------------------------- picker

  async function openPicker(dest) {
    const input = dest === "rewatch" ? rewatchInput : progressInput;
    const t = type();
    const locked = dest === "progress" && finishedEnded();
    const everything = EVERYTHING_RE.test(input.value.trim());
    const base = { title: titleInput.value.trim() || "Set progress", locked, forRewatch: dest === "rewatch",
      progress: parseProgress(input.value, t) };
    let opts;
    if (isTmdbShow()) {
      opts = { ...base, mode: "tmdb", tmdbId: f.link.id, episodeGroup: f.episodeGroup, entryId: editing ? e.id : null,
        followLatest: everything || locked,
        specials: dest === "rewatch" ? null : f.specials,
        onGrouping: (newGroup) => switchGrouping(newGroup, dest) };
    } else if (t === "Show") {
      const count = episodeCount();
      opts = { ...base, mode: "abs", count, complete: airing() !== "airing",
        progress: (everything || locked) && count ? { episode: count } : base.progress };
    } else {
      const known = f.chapterOverride ?? chapterCount();
      opts = { ...base, mode: "chapter", latest: known, complete: airing() !== "airing",
        progress: everything && known != null ? { chapter: known } : base.progress,
        latestFallback: known == null ? liveChapterLatest : null,
        onFixLatest: async (current) => {
          const value = await promptLatestChapter({ current, isOverride: f.chapterOverride != null });
          if (value !== undefined) f.chapterOverride = value;
          return value;
        } };
    }
    const result = await pickProgress(opts);
    if (!result) return;
    if (result.kind === "specials") {
      f.specials = result.refs;
    } else {
      // A rewatch that reached an ended show's finale reads "Everything".
      input.value = dest === "rewatch" && result.finale ? "Everything" : result.label;
      if (dest === "progress") f.untracked = false;
    }
    sync();
  }

  // The picker's "Change grouping": remap the unsaved field values.
  async function switchGrouping(newGroup, dest) {
    const oldGroup = f.episodeGroup;
    const points = [];
    const prog = parseProgress(progressInput.value, "Show");
    const rw = parseProgress(rewatchInput.value, "Show");
    const refs = [];
    for (const [key, p] of [["progress", prog], ["rewatch", rw], ...f.prevRest.map((p, i) => [i, p])]) {
      if (p && p.season != null) { refs.push(key); points.push({ season: p.season, episode: p.episode }); }
    }
    let mapped = points.map(() => null);
    if (points.length) {
      try { mapped = (await API.remap(f.link.id, oldGroup, newGroup, points)).points || mapped; } catch (_) { /* keep raw */ }
    }
    f.episodeGroup = newGroup;
    structureMemo = null;
    refs.forEach((key, i) => {
      const p = mapped[i];
      if (!p) return;
      if (key === "progress") progressInput.value = progressText(p);
      else if (key === "rewatch") rewatchInput.value = progressText(p);
      else f.prevRest[key] = p;
    });
    // An ended show's Everything follows the new grouping's finale.
    if (finishedEnded()) progressInput.value = "";
    await resolveShowEnd();
    return { progress: parseProgress((dest === "rewatch" ? rewatchInput : progressInput).value, "Show") };
  }

  // ---------------------------------------------------------------- linking

  function buildSourceOptions() {
    const groupType = type() === "Group";
    const previous = sourceSelect.value;
    sourceSelect.replaceChildren(...sources()
      .filter((s) => !s.secondary && (s.id === "none" || groupType === !!s.group))
      .map((s) => h("option", { value: s.id }, s.label)));
    if ([...sourceSelect.options].some((o) => o.value === previous)) sourceSelect.value = previous;
  }

  function renderLinkChip() {
    linkChip.hidden = !f.link;
    if (!f.link) return linkChip.replaceChildren();
    const d = f.link.details || {};
    const name = f.link.title || d.title || titleInput.value.trim();
    clear(linkChip,
      f.link.thumb_url ? poster(f.link.thumb_url, { type: type() }) : (editing && e.poster && !f.linkChanged ? poster(e.poster) : null),
      h("span", { class: "link-chip-text" }, "Linked: ",
        f.link.url ? h("a", { href: f.link.url, target: "_blank", rel: "noopener noreferrer" }, name) : name,
        h("span", { class: "muted" }, ` (${linkLabel(f.link.source)})`)),
      iconButton("close", "Unlink", unlink, { size: 15 }));
  }

  function renderChapterChip() {
    const src = secondarySource();
    chapterChip.hidden = !f.chapterLink || type() !== "Comic";
    if (chapterChip.hidden) return;
    const cl = f.chapterLink;
    clear(chapterChip,
      h("span", { class: "link-chip-text" }, "Chapters via ",
        cl.url ? h("a", { href: cl.url, target: "_blank", rel: "noopener noreferrer" }, cl.title || cl.id) : cl.title || cl.id,
        h("span", { class: "muted" }, ` (${sourceLabel(cl.source) || (src && src.label)})`)),
      iconButton("close", "Remove chapter source", () => { f.chapterLink = null; sync(); }, { size: 15 }));
  }

  async function unlink() {
    if (!f.link) return;
    const ok = await confirm({ title: "Unlink source?",
      message: `Unlink "${titleInput.value.trim()}" from ${linkLabel(f.link.source)}? The source becomes None and cached artwork is removed when you save.`,
      confirmLabel: "Unlink" });
    if (!ok) return;
    cancelPending();
    f.link = null;
    f.linkChanged = true;
    sourceSelect.value = "none";
    group.onLinkChanged(null, false);
    updateCollectionSuggestion();
    sync();
  }

  function updateCollectionSuggestion() {
    f.collectionGroup = null;
    collectionSuggest.hidden = true;
    collectionCheck.checked = false;
    const d = linkDetails();
    if (editing || type() !== "Movie" || !f.link || f.link.source !== "tmdb_movie" || d.collection_id == null) return;
    const g = state.entries.find((x) => isGroup(x) && !x.collection && x.link && x.link.source === "tmdb_collection"
      && String(x.link.id) === String(d.collection_id));
    if (!g) return;
    f.collectionGroup = g.id;
    collectionSuggest.lastChild.replaceWith(h("span", null, "Add to ", h("strong", null, g.title)));
    collectionSuggest.hidden = false;
  }

  let removeSuggestEscape = null;
  function closeSuggest() {
    suggest.hidden = true;
    suggest.replaceChildren();
    searchSeq.invalidate();
    if (removeSuggestEscape) { removeSuggestEscape(); removeSuggestEscape = null; }
  }

  function showSuggest(nodes) {
    suggest.replaceChildren(...nodes);
    suggest.hidden = false;
    if (!removeSuggestEscape) removeSuggestEscape = onEscape(closeSuggest);
  }

  const suggestStatus = (text) => h("div", { class: "suggest-status" }, text);

  // A newer choice (type, source, unlink) must win over a lookup or search
  // still in flight.
  function cancelPending() {
    pickSeq.invalidate();
    endSeq.invalidate();
    debouncedSearch.cancel();
    closeSuggest();
  }

  async function pickResult(result) {
    const token = pickSeq.next();
    titleInput.value = result.title;
    closeSuggest();
    let details = result.details || {};
    if (result.source === "tmdb_tv" || result.source === "tmdb_movie") {
      try {
        details = { ...details, ...((await API.lookup(result.source, result.id)).details || {}) };
      } catch (_) { /* search-time details are enough to link */ }
    }
    if (!pickSeq.isCurrent(token)) return;
    // A Comic's override and chapter source, and a Show's grouping and
    // specials, describe the title they were set on; another title starts clean.
    const key = `${result.source}:${result.id}`;
    if (f.stateLink && f.stateLink !== key) {
      f.chapterOverride = null;
      f.chapterLink = null;
      f.episodeGroup = null;
      f.specials = [];
    }
    f.stateLink = key;
    f.link = { source: result.source, id: result.id, url: result.url, thumb_url: result.thumb_url, details, title: result.title };
    f.linkChanged = true;
    f.showEnd = null;
    structureMemo = null;
    group.onLinkChanged(f.link, true);
    updateCollectionSuggestion();
    sync();
    if (type() === "Show") resolveShowEnd();
  }

  async function runSearch() {
    const src = sourceSelect.value;
    const q = titleInput.value.trim();
    if (!sourceInfo(src) || !sourceInfo(src).searchable || q.length < 2) return closeSuggest();
    const token = searchSeq.next();
    showSuggest([suggestStatus("Searching…")]);
    try {
      const { results } = await API.search(src, q);
      if (!searchSeq.isCurrent(token)) return;
      if (!results.length) return showSuggest([suggestStatus("No matches — you can still save it as a plain entry.")]);
      showSuggest(results.map((r) => h("button", { type: "button", class: "suggest-item", onClick: () => pickResult(r) },
        poster(r.thumb_url, { type: type() }),
        h("span", { class: "suggest-text" },
          h("span", { class: "suggest-title" }, r.title),
          h("span", { class: "suggest-meta" }, [r.meta, linkLabel(r.source)].filter(Boolean).join(" · "))))));
    } catch (err) {
      if (searchSeq.isCurrent(token)) showSuggest([suggestStatus(err.message)]);
    }
  }
  const debouncedSearch = debounce(runSearch, 300);

  function onTitleInput() {
    debouncedSearch.cancel();
    const src = sourceInfo(sourceSelect.value);
    if (src && src.search_on_enter) {
      if (titleInput.value.trim().length >= 2) showSuggest([suggestStatus("Press Enter to search.")]);
      else closeSuggest();
      return;
    }
    debouncedSearch();
  }

  async function editTitles() {
    const result = await openTitleOptions({ form: { title: titleInput.value.trim(), synonym: f.synonym, link: f.link } });
    if (!result) return;
    if ("title" in result) {
      titleInput.value = result.title;
      if (f.synonym === result.title) f.synonym = null;
    }
    if ("synonym" in result) f.synonym = result.synonym;
    sync();
  }

  // ---------------------------------------------------------------- visibility

  function reveal(key) {
    f.revealed.add(key);
    if (key === "rewatch") {
      if (structural()) f.hasRewatch = true;
      else f.hasCount = true;
    }
    sync();
    const focusTarget = { notes: notesInput, progress: progressInput, rewatch: structural() ? rewatchInput : countInput }[key];
    if (focusTarget) focusTarget.focus();
  }

  function sync() {
    const t = type();
    const st = status();
    const groupType = t === "Group";
    const collection = collectionMode();
    const terminal = isTerminal(st);
    const v = verbs(t);

    // Status & completion date (a plain Group has neither). A Group that
    // becomes a collection starts as Finished, like other non-episodic types.
    statusField.hidden = groupType && !collection;
    if (groupType && collection && !e.status && !f.groupStatusSeeded) {
      statusSelect.value = "finished";
      f.groupStatusSeeded = true;
    }
    const showDate = terminal && (!groupType || collection);
    dateCompleteField.hidden = !showDate;
    statusRow.hidden = statusField.hidden && !showDate;
    dateCompleteLabel.textContent = st === "dropped" ? "Date dropped" : "Date completed";
    unknownDate.parentElement.hidden = st !== "finished";
    if (st !== "finished") unknownDate.checked = false;
    dateCompleteInput.disabled = unknownDate.checked;
    if (showDate && !unknownDate.checked && !dateCompleteInput.value) dateCompleteInput.value = todayISO();

    // Progress: visible for Started Shows/Comics, On hold and Dropped, and a
    // finished Show; otherwise behind "+ Up to" unless it has a value.
    const hasProgress = !!progressInput.value.trim();
    let progressShown = false;
    if (!groupType && st !== "planned") {
      if (st === "on_hold" || st === "dropped") progressShown = true;
      else if (st === "finished") progressShown = t === "Show" || hasProgress;
      else progressShown = structural() || hasProgress;
      progressShown = progressShown || f.revealed.has("progress");
    }
    progressField.hidden = !progressShown;
    progressLabel.replaceChildren(st === "started" || st === "finished" ? "Up to" : "Stopped at",
      h("span", { class: "hint" }, structural() ? " (episode / chapter)" : " (free text)"));
    progressInput.placeholder = structural() ? "e.g. S2E5 · 12 · Ch 34" : "e.g. halfway · page 200";
    progressPick.hidden = !pickAvailable();
    specialsNote.hidden = !(t === "Show" && f.specials.length);
    specialsNote.textContent = `+ ${f.specials.length} special${f.specials.length === 1 ? "" : "s"} watched`;
    refreshProgressDisplay();

    // Rewatches: a point for Shows/Comics, a counter for everything else.
    rewatchField.hidden = groupType || !structural() || !f.hasRewatch;
    rewatchLabel.replaceChildren(v.again, h("span", { class: "hint" }, " (how far you got the previous time)"));
    rewatchInput.placeholder = "e.g. S2E5 · 12 · Everything";
    rewatchPick.hidden = !pickAvailable();
    countField.hidden = groupType || structural() || !f.hasCount;
    countLabel.textContent = `Times ${v.repeated.toLowerCase()}`;

    // Rating: shown for terminal statuses, behind "+ Rating" for Started/On
    // hold, hidden for Planned; an existing rating always stays visible.
    const hasRating = rating != null;
    const ratingShown = groupType ? hasRating || f.revealed.has("rating")
      : hasRating || (st !== "planned" && (terminal || f.revealed.has("rating")));
    ratingField.hidden = !ratingShown;
    clear(ratingHolder, ratingScale(rating, (n) => { rating = rating === n ? null : n; sync(); }),
      hasRating ? h("button", { type: "button", class: "btn-link", onClick: () => { rating = null; sync(); } }, "Clear rating") : null);

    notesField.hidden = !(notesInput.value.trim() || f.revealed.has("notes"));
    // Only Shows can be ignored (the Tracker's show menu sets it).
    ignoredLabel.hidden = type() !== "Show" || !editing;
    group.el.hidden = !groupType;
    titleEdit.title = f.link && hasAltTitles(f.link.source)
      ? "Choose the main title or set a synonym" : "Set a synonym";

    renderLinkChip();
    renderChapterChip();
    const addBtn = (key, label, show) => show
      ? h("button", { type: "button", class: "adder", onClick: () => (key === "chapter" ? addChapterSource() : reveal(key)) }, label) : null;
    adders.replaceChildren(...[
      addBtn("rating", "+ Rating", !ratingShown && (groupType || st !== "planned")),
      addBtn("notes", "+ Notes", notesField.hidden),
      addBtn("progress", `+ ${st === "on_hold" || st === "dropped" ? "Stopped at" : "Up to"}`, !groupType && st !== "planned" && progressField.hidden),
      addBtn("rewatch", `+ ${structural() ? v.again : v.repeated}`,
        !groupType && st !== "planned" && (structural() ? !f.hasRewatch : !f.hasCount)),
      addBtn("chapter", "+ Chapter source", t === "Comic" && !f.chapterLink && !!secondarySource()),
      ...(groupType ? group.adders() : []),
    ].filter(Boolean));
    adders.hidden = !adders.children.length;
  }

  async function addChapterSource() {
    const picked = await pickChapterSource(titleInput.value.trim());
    if (picked) {
      f.chapterLink = picked;
      sync();
    }
  }

  // ---------------------------------------------------------------- events

  typeSelect.addEventListener("change", () => {
    buildSourceOptions();
    sourceSelect.value = defaultSourceFor(type());
    cancelPending();
    f.link = null;
    f.linkChanged = editing ? !!e.link : false;
    // Media-specific pending values can't carry across a type change.
    f.chapterOverride = null;
    f.chapterLink = null;
    f.episodeGroup = null;
    f.specials = [];
    f.showEnd = null;
    if (!editing && !f.statusTouched) statusSelect.value = isStructural(type()) ? "started" : "finished";
    group.onLinkChanged(null, false);
    updateCollectionSuggestion();
    sync();
    if (type() === "Show") resolveShowEnd();
  });
  sourceSelect.addEventListener("change", () => {
    cancelPending();
    if (f.link) { f.link = null; f.linkChanged = true; group.onLinkChanged(null, false); }
    const src = sourceInfo(sourceSelect.value);
    if (src && src.search_on_enter) {
      if (titleInput.value.trim().length >= 2) showSuggest([suggestStatus("Press Enter to search.")]);
    } else {
      runSearch();
    }
    sync();
  });
  titleInput.addEventListener("input", onTitleInput);
  titleInput.addEventListener("keydown", (ev) => {
    const src = sourceInfo(sourceSelect.value);
    if (ev.key === "Enter" && src && src.search_on_enter) {
      ev.preventDefault();
      debouncedSearch.cancel();
      runSearch();
    }
  });
  statusSelect.addEventListener("change", () => {
    f.statusTouched = true;
    f.untracked = false;
    sync();
    if (type() === "Show") resolveShowEnd();
  });
  unknownDate.addEventListener("change", () => {
    if (unknownDate.checked) dateCompleteInput.value = "";
    sync();
  });
  progressInput.addEventListener("input", () => { f.untracked = false; });

  // ---------------------------------------------------------------- save

  async function latestTarget(t) {
    try {
      if (isTmdbShow()) {
        const st = await showStructure();
        return { target: st.last_aired && st.last_aired.season != null ? { season: st.last_aired.season, episode: st.last_aired.episode } : null,
          ended: !st.next_air && !st.in_production };
      }
      if (t === "Show") {
        const c = episodeCount();
        return { target: c ? { episode: c } : null, ended: airing() !== "airing" };
      }
      let c = f.chapterOverride ?? chapterCount();
      if (c == null) c = await liveChapterLatest();
      return { target: c != null ? { chapter: c } : null, ended: airing() !== "airing" };
    } catch (_) {
      return { target: null };
    }
  }

  // Save-time sanity checks. Resolves false to cancel the save.
  async function preflight(payload) {
    const t = payload.type;
    const prog = parseProgress(payload.progress, t);
    if (!prog || prog.text) return true;
    const info = await latestTarget(t);
    if (modal.closed) return false;
    const unit = t === "Comic" ? "chapter" : "episode";
    if (info.target && pointReaches(prog, info.target, true)) {
      const ok = await confirm({ title: `${t === "Comic" ? "Chapter" : "Episode"} beyond the latest?`,
        message: `You entered ${progressText(prog)}, but the latest ${unit} ${t === "Comic" ? "released" : "aired"} is ${progressText(info.target)}. Save it anyway?`,
        confirmLabel: "Save anyway" });
      if (ok && t === "Comic" && prog.chapter != null) payload.chapter_override = prog.chapter;
      return ok;
    }
    if (t === "Comic" && prog.chapter != null && !info.target) {
      if (await confirm({ title: "Set the latest chapter?",
        message: `No latest chapter is known for this comic yet. Also make ${progressText(prog)} the latest chapter?`,
        confirmLabel: "Set both", cancelLabel: "Just progress" })) payload.chapter_override = prog.chapter;
      return true;
    }
    if (payload.status === "dropped" && pointReaches(prog, info.target)) {
      return confirm({ title: "Mark as dropped?",
        message: `Every ${unit} released so far is marked ${verbs(t).done}, but the status is dropped. Did you mean finished?`,
        confirmLabel: "Save as dropped" });
    }
    if (payload.status === "started" && info.ended && pointReaches(prog, info.target)) {
      if (await confirm({ title: "Mark as finished?",
        message: `You've ${verbs(t).done} every ${unit} of a ${t === "Comic" ? "completed comic" : "show that's ended"}, but the status is started. Switch it to finished?`,
        confirmLabel: "Switch to finished", cancelLabel: "Keep started" })) {
        payload.status = "finished";
        payload.date_complete = payload.date_complete || todayISO();
      }
    }
    return true;
  }

  function duplicateOf(payload) {
    const title = payload.title.toLowerCase();
    const syn = (payload.synonym || "").toLowerCase();
    const matches = state.entries.filter((x) => {
      const t = x.title.trim().toLowerCase();
      const s = (x.synonym || "").trim().toLowerCase();
      return t === title || (syn && (t === syn || s === syn)) || (s && s === title);
    });
    return matches.find((x) => x.type === payload.type) || matches[0] || null;
  }

  function buildPayload() {
    const t = type();
    const st = status();
    const payload = {
      title: titleInput.value.trim(), type: t, synonym: f.synonym, status: st,
      date_complete: isTerminal(st) && !unknownDate.checked ? dateCompleteInput.value || todayISO() : null,
      rating, notes: notesInput.value.trim(), hidden: hiddenCheck.checked,
      progress: progressField.hidden ? null : progressInput.value.trim(),
    };
    if (structural()) {
      payload.ignored = type() === "Show" && ignoredCheck.checked;
      payload.previous_watches = f.hasRewatch ? [rewatchInput.value.trim() || "Everything", ...f.prevRest] : f.prevRest;
    } else {
      payload.rewatch_count = f.hasCount ? parseInt(countInput.value, 10) || null : null;
    }
    if (t === "Comic") {
      payload.chapter_override = f.chapterOverride;
      payload.chapter_link = f.chapterLink;
    }
    if (t === "Show") {
      payload.episode_group = f.episodeGroup;
      payload.specials_watched = f.specials;
    }
    if (!editing || f.linkChanged) {
      payload.link = f.link ? { source: f.link.source, id: f.link.id, url: f.link.url,
        thumb_url: f.link.thumb_url, details: f.link.details } : null;
    }
    if (!editing && f.collectionGroup && collectionCheck.checked) payload.group = f.collectionGroup;
    if (t === "Group") Object.assign(payload, group.payload());
    return payload;
  }

  async function submit() {
    if (f.submitting) return;
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return toast("A title is required.");
    }
    f.submitting = true;
    saveBtn.disabled = true;
    closeSuggest();
    try {
      const payload = buildPayload();
      if (!editing && !dateAddedField.hidden) {
        const raw = dateAddedRaw.value.trim();
        if (raw && !TIMESTAMP_RE.test(raw)) return toast("Couldn't read that timestamp — expected something like 2024-05-23T15:12:03Z.");
        payload.date_added = raw || dateAddedInput.value || null;
      }
      if (payload.type !== "Group") {
        payload.progress = await resolveEverything(payload.progress);
        if (payload.previous_watches) {
          payload.previous_watches = await Promise.all(payload.previous_watches.map((p) =>
            (typeof p === "string" ? resolveEverything(p) : p)));
        }
        // An edit that leaves progress and status alone was already checked.
        const unchanged = editing && !f.linkChanged && payload.type === e.type && payload.status === e.status
          && samePoint(parseProgress(payload.progress, payload.type), e.progress);
        if (structural() && !unchanged && !(await preflight(payload))) return;
        if (!editing) {
          const dup = duplicateOf(payload);
          if (dup) {
            const same = dup.type === payload.type;
            const choice = await choose({ title: "Already in your catalog",
              message: `"${dup.title}" (${dup.type}, ${statusLabel(dup.status) || "group"}) is already saved. ` +
                (same ? "Same title and type — this is likely a duplicate." : "Different type — this may be an adaptation or another format."),
              options: [{ label: "Cancel", value: null }, { label: "Edit existing", value: "edit" },
                { label: "Add as new", value: "add", kind: "primary" }] });
            if (choice === "edit") { modal.close(); openEntryForm(dup); return; }
            if (choice !== "add") return;
          }
        }
      }
      // A form closed during the lookups above is abandoned, never saved.
      if (modal.closed) return;
      const result = applyResult(editing ? await API.update(e.id, payload) : await API.create(payload));
      // Group saves (and type changes to or from Group) change other entries'
      // membership server-side; reload so the client sees them.
      if (payload.type === "Group" || (editing && isGroup(e))) setEntries(await API.entries());
      prefs.set("form.lastType", payload.type);
      toast(editing ? (payload.type === "Group" ? "Group updated." : "Entry updated.")
        : (payload.type === "Group" ? "Group created." : "Entry added."));
      modal.close(result.entry);
    } catch (err) {
      toastError(err);
    } finally {
      f.submitting = false;
      saveBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- mount

  const form = h("form", { class: "entry-form", novalidate: true,
    onSubmit: (ev) => { ev.preventDefault(); submit(); } },
    h("div", { class: "field-row" }, field("Type", dropdown(typeSelect)), field("Source", dropdown(sourceSelect))),
    h("div", { class: "field title-field" },
      h("span", { class: "field-label" }, "Title"),
      h("div", { class: "inline-row" }, titleInput, titleEdit),
      suggest),
    linkChip, chapterChip,
    dateAddedField,
    statusRow,
    progressField, rewatchField, countField, ratingField, notesField,
    group.el, collectionSuggest,
    h("button", { type: "submit", hidden: true, tabindex: -1, "aria-hidden": "true" }),
    h("div", { class: "form-options" }, h("label", { class: "check" }, hiddenCheck, "Hide entry"), ignoredLabel),
    adders);

  const saveBtn = h("button", { type: "button", class: "btn btn-primary", onClick: submit }, "Save");
  const modal = openModal({
    title: editing ? (isGroup(e) ? "Edit group" : "Edit entry") : "Add entry",
    size: "md", className: "entry-modal", content: form,
  });
  append(modal.footer, [
    editing ? h("button", { type: "button", class: "btn btn-quiet danger spacer",
      onClick: async () => { if (await deleteEntry(e)) modal.close(); } }, icon("trash", 15), "Delete") : null,
    h("button", { type: "button", class: "btn btn-ghost", onClick: () => modal.close() }, "Cancel"), saveBtn]);
  modal.footer.hidden = false;

  const outside = (ev) => { if (!ev.target.closest(".title-field")) closeSuggest(); };
  document.addEventListener("mousedown", outside);
  modal.result.then(() => {
    document.removeEventListener("mousedown", outside);
    cancelPending();
  });

  buildSourceOptions();
  sourceSelect.value = f.link ? searchSourceForLink(f.link.source, f.type) || defaultSourceFor(f.type) : defaultSourceFor(f.type);
  if (!editing) statusSelect.value = prefill.status || (isStructural(f.type) ? "started" : "finished");
  sync();
  if (f.type === "Show") resolveShowEnd();
  if (!editing) requestAnimationFrame(() => titleInput.focus());
  if (!editing && titleInput.value.trim()) onTitleInput();
  return modal;
}
