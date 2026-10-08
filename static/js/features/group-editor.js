// The Group section of the entry form. A plain Group lists its members,
// suggestions and search results, never the whole catalog; a collection
// lists the linked source's full membership.

import { API } from "../core/api.js";
import { clear, debounce, h, icon, sequence } from "../core/dom.js";
import { state } from "../core/store.js";
import { normalizeSearch, statusLabel } from "../core/format.js";
import { collator, isGroup, kindType, matchesQuery, orderedMembers, orderedSourceMembers, posterOf } from "../core/model.js";
import { poster } from "../ui/poster.js";
import { dropdown } from "../ui/dropdown.js";

const SORTS = [
  ["release", "Release date (oldest first)"], ["newest", "Release date (newest first)"],
  ["added", "Date added (oldest first)"], ["added_newest", "Date added (newest first)"], ["manual", "Manual order"],
];

export function groupEditor({ entry, getLink, getTitle, onChange }) {
  const g = entry || {};
  const s = {
    always: !!g.always_group,
    collection: !!g.collection,
    members: new Set(entry ? state.entries.filter((e) => e.group === g.id).map((e) => e.id) : []),
    suggested: new Set(),
    sort: g.member_sort || "release",
    order: (g.member_order || []).slice(),
    cover: g.cover || null,
    sourceMembers: [],
    excluded: new Set(g.collection_excluded || []),
    ratings: { ...(g.collection_ratings || {}) },
    loading: false,
    thumbnail: !!g.cover,
  };
  const loadSeq = sequence();
  const suggestSeq = sequence();

  const alwaysCheck = h("input", { type: "checkbox" });
  const collectionCheck = h("input", { type: "checkbox" });
  const sortSelect = h("select", { class: "select" });
  const currentLabel = h("span", { class: "field-label" });
  const current = h("div", { class: "choice-list group-members" });
  const currentEmpty = h("p", { class: "inline-note", hidden: true });
  const searchInput = h("input", { type: "search", class: "input", placeholder: "Search your catalog…", autocomplete: "off" });
  const results = h("div", { class: "choice-list group-members" });
  const resultsEmpty = h("p", { class: "inline-note", hidden: true });
  const searchField = h("div", { class: "field" }, h("span", { class: "field-label" }, "Add members"), searchInput, results, resultsEmpty);
  const thumbSelect = h("select", { class: "select" });
  const thumbField = h("label", { class: "field", hidden: true }, h("span", { class: "field-label" }, "Thumbnail"), dropdown(thumbSelect));

  const el = h("div", { class: "group-editor" },
    h("div", { class: "group-options" },
      h("label", { class: "check" }, alwaysCheck, "Always show as a group"),
      h("label", { class: "check" }, collectionCheck, "Act as a collection")),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Sort members by"), dropdown(sortSelect)),
    h("div", { class: "field" }, currentLabel, current, currentEmpty),
    searchField, thumbField);

  const linked = () => { const l = getLink(); return !!(l && l.id); };
  const checkedEntries = () => state.entries.filter((e) => s.members.has(e.id));
  const includedSource = () => s.sourceMembers.filter((m) => !s.excluded.has(m.ref));

  function displayOrder() {
    return s.collection
      ? orderedSourceMembers(s.sourceMembers, s.sort, s.order)
      : orderedMembers(checkedEntries(), s.sort, s.order);
  }

  function move(key, delta) {
    const i = s.order.indexOf(key);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= s.order.length) return;
    s.order.splice(j, 0, s.order.splice(i, 1)[0]);
    render();
  }

  function reorderButtons(key, first, last) {
    return [
      h("button", { type: "button", class: "icon-btn reorder", title: "Move up", disabled: first,
        onClick: (ev) => { ev.preventDefault(); move(key, -1); } }, icon("chevronUp", 15)),
      h("button", { type: "button", class: "icon-btn reorder", title: "Move down", disabled: last,
        onClick: (ev) => { ev.preventDefault(); move(key, 1); } }, icon("chevronDown", 15)),
    ];
  }

  function entryChoice(e, reorder) {
    const box = h("input", { type: "checkbox", checked: s.members.has(e.id) });
    box.addEventListener("change", () => {
      if (box.checked) {
        s.members.add(e.id);
        if (s.sort === "manual" && !s.order.includes(e.id)) s.order.push(e.id);
      } else {
        s.members.delete(e.id);
        s.order = s.order.filter((id) => id !== e.id);
        if (s.cover === e.id) s.cover = null;
      }
      render();
    });
    return h("label", { class: "choice" }, box, poster(posterOf(e), { type: e.type }),
      h("span", { class: "choice-title wrap" }, e.title),
      s.suggested.has(e.id) && !s.members.has(e.id) ? h("span", { class: "tag tag-teal" }, "Suggested") : null,
      h("span", { class: "choice-meta" }, `${e.type} · ${statusLabel(e.status)}`),
      reorder || null);
  }

  function sourceChoice(m, reorder) {
    const box = h("input", { type: "checkbox", checked: !s.excluded.has(m.ref) });
    box.addEventListener("change", () => {
      if (box.checked) {
        s.excluded.delete(m.ref);
        if (s.sort === "manual" && !s.order.includes(m.ref)) s.order.push(m.ref);
      } else {
        s.excluded.add(m.ref);
        s.order = s.order.filter((r) => r !== m.ref);
        if (s.cover === m.ref) s.cover = null;
      }
      render();
    });
    const rating = h("select", { class: "select rating-select", title: "Rating", "aria-label": `Rating for ${m.title}` },
      ["", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => h("option", { value: n, selected: String(s.ratings[m.ref] ?? "") === String(n) }, n === "" ? "–" : n)));
    rating.addEventListener("change", () => {
      const n = parseInt(rating.value, 10);
      if (Number.isFinite(n)) s.ratings[m.ref] = n;
      else delete s.ratings[m.ref];
    });
    return h("label", { class: "choice" }, box, poster(m.thumb_url, { type: kindType(m.kind) }),
      h("span", { class: "choice-title wrap" }, m.title || "Untitled"),
      h("span", { class: "choice-meta" }, (m.release_date || "").slice(0, 4)),
      dropdown(rating), reorder || null);
  }

  function renderCurrent() {
    const manual = s.sort === "manual";
    if (s.collection) {
      if (manual) {
        // A newly discovered or re-included member joins the end of the order.
        for (const m of includedSource()) if (!s.order.includes(m.ref)) s.order.push(m.ref);
      }
      const rows = displayOrder();
      const included = rows.filter((m) => !s.excluded.has(m.ref));
      current.replaceChildren(...rows.map((m) => {
        const i = included.indexOf(m);
        return sourceChoice(m, manual && i !== -1 ? reorderButtons(m.ref, i === 0, i === included.length - 1) : null);
      }));
      currentLabel.textContent = "In this collection";
      currentEmpty.textContent = s.loading ? "Loading the collection…"
        : s.loadFailed ? "Couldn't load the collection from its source. Reopen the form to try again."
          : "The linked source lists no members.";
      currentEmpty.hidden = !!rows.length;
      current.hidden = !rows.length;
      return;
    }
    if (manual) for (const id of s.members) if (!s.order.includes(id)) s.order.push(id);
    const rows = displayOrder();
    current.replaceChildren(...rows.map((e, i) =>
      entryChoice(e, manual ? reorderButtons(e.id, i === 0, i === rows.length - 1) : null)));
    currentLabel.textContent = "In this group";
    currentEmpty.textContent = "No members yet.";
    currentEmpty.hidden = !!rows.length;
    current.hidden = !rows.length;
  }

  function renderResults() {
    searchField.hidden = s.collection;
    if (s.collection) return;
    const shown = new Set(s.members);
    const byTitle = (list) => list.sort((a, b) => collator.compare(a.title, b.title));
    const suggested = byTitle(state.entries.filter((e) => s.suggested.has(e.id) && !shown.has(e.id)));
    suggested.forEach((e) => shown.add(e.id));
    const qn = normalizeSearch(searchInput.value);
    const searching = qn.length >= 2;
    const found = searching ? byTitle(state.entries.filter((e) => !isGroup(e) && !shown.has(e.id)
      && (!e.group || e.group === g.id) && matchesQuery(e, qn))).slice(0, 25) : [];
    const nodes = [];
    if (suggested.length) nodes.push(h("div", { class: "choice-heading" }, "Suggested"), ...suggested.map((e) => entryChoice(e)));
    if (found.length) nodes.push(h("div", { class: "choice-heading" }, "Search results"), ...found.map((e) => entryChoice(e)));
    results.replaceChildren(...nodes);
    results.hidden = !nodes.length;
    resultsEmpty.hidden = !!nodes.length;
    resultsEmpty.textContent = searching ? "No matching entries."
      : "Search your catalog to add entries, or link a collection or series above for suggestions.";
  }

  function renderThumbnail() {
    thumbField.hidden = !s.thumbnail;
    // Never drop a saved cover just because the source didn't load.
    if (!s.thumbnail || (s.collection && (s.loading || !s.sourceMembers.length))) return;
    const options = s.collection
      ? displayOrder().filter((m) => !s.excluded.has(m.ref)).map((m) => [m.ref, m.title || "Untitled"])
      : displayOrder().map((e) => [e.id, e.title]);
    if (!options.some(([v]) => v === s.cover)) s.cover = null;
    clear(thumbSelect, h("option", { value: "" }, "The group's own artwork"),
      options.map(([v, label]) => h("option", { value: v, selected: v === s.cover }, label)));
  }

  function render() {
    if (s.collection) s.always = true;
    alwaysCheck.checked = s.always;
    alwaysCheck.disabled = s.collection;
    collectionCheck.checked = s.collection;
    // Collection mode replaces catalog membership, so it can't be switched
    // on while catalog members are checked, or without a group-source link.
    collectionCheck.disabled = !s.collection && (s.members.size > 0 || !linked());
    for (const box of [alwaysCheck, collectionCheck]) box.parentElement.classList.toggle("is-disabled", box.disabled);
    sortSelect.replaceChildren(...SORTS.filter(([v]) => !s.collection || !v.startsWith("added"))
      .map(([v, label]) => h("option", { value: v, selected: v === s.sort }, label)));
    renderCurrent();
    renderResults();
    renderThumbnail();
  }

  async function loadSourceMembers({ live = false } = {}) {
    const token = loadSeq.next();
    const link = getLink();
    const sameSaved = entry && entry.collection && link && entry.link &&
      link.source === entry.link.source && String(link.id) === String(entry.link.id);
    if (!link || !link.id) {
      s.sourceMembers = [];
      s.loading = false;
      return render();
    }
    s.loading = true;
    s.sourceMembers = [];
    render();
    try {
      const params = sameSaved && !live ? { group: entry.id } : { source: link.source, id: link.id, title: getTitle() };
      const { members } = await API.collection(params);
      if (!loadSeq.isCurrent(token)) return;
      s.sourceMembers = members || [];
      s.loadFailed = false;
    } catch (_) {
      if (!loadSeq.isCurrent(token)) return;
      s.sourceMembers = [];
      s.loadFailed = true;
    }
    s.loading = false;
    render();
  }

  async function loadSuggestions(link, preCheck) {
    const token = suggestSeq.next();
    try {
      const { ids } = await API.groupSuggestions(link.source, link.id, getTitle());
      if (!suggestSeq.isCurrent(token)) return;
      for (const id of ids) {
        s.suggested.add(id);
        if (preCheck) s.members.add(id);
      }
    } catch (_) { /* the manual picker still works */ }
    if (suggestSeq.isCurrent(token)) render();
  }

  alwaysCheck.addEventListener("change", () => { s.always = alwaysCheck.checked; });
  collectionCheck.addEventListener("change", () => {
    s.collection = collectionCheck.checked;
    s.cover = null;
    s.order = [];
    if (s.sort === "manual") s.sort = "release";
    if (s.collection) loadSourceMembers();
    else loadSeq.invalidate();
    render();
    onChange();
  });
  sortSelect.addEventListener("change", () => {
    const previous = s.sort;
    s.sort = sortSelect.value;
    // The first switch to Manual starts from the order already on screen.
    if (s.sort === "manual" && !s.order.length) {
      s.order = (s.collection
        ? orderedSourceMembers(includedSource(), previous, null).map((m) => m.ref)
        : orderedMembers(checkedEntries(), previous, null).map((e) => e.id));
    }
    render();
  });
  searchInput.addEventListener("input", debounce(render, 150));
  // Enter filters the list; it must not submit the whole form.
  searchInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ev.preventDefault(); });
  thumbSelect.addEventListener("change", () => { s.cover = thumbSelect.value || null; });

  if (s.collection) loadSourceMembers();
  else if (entry && entry.link) loadSuggestions(entry.link, false);
  render();

  return {
    el,
    state: s,
    adders() {
      if (s.thumbnail || !(getLink() || s.members.size || s.sourceMembers.length)) return [];
      return [h("button", { type: "button", class: "adder", onClick: () => { s.thumbnail = true; render(); onChange(); } }, "+ Thumbnail")];
    },
    // A new pick replaces a collection's membership outright; for a plain
    // Group it offers suggestions (pre-checked only for a brand-new group).
    onLinkChanged(link, isNewPick) {
      s.suggested = new Set();
      suggestSeq.invalidate();
      if (!link) {
        if (s.collection) {
          s.collection = false;
          s.sourceMembers = [];
          s.excluded = new Set();
          s.ratings = {};
          s.cover = null;
          s.order = [];
          loadSeq.invalidate();
        }
        render();
        return;
      }
      if (s.collection) {
        s.excluded = new Set();
        s.ratings = {};
        s.cover = null;
        s.order = [];
        loadSourceMembers({ live: true });
      } else if (isNewPick) {
        loadSuggestions(link, !entry);
      }
      render();
    },
    payload() {
      const manual = s.sort === "manual";
      return {
        always_group: s.always,
        collection: s.collection,
        member_sort: s.sort === "release" ? null : s.sort,
        member_order: manual ? s.order.filter((k) => (s.collection ? !s.excluded.has(k) : s.members.has(k))) : null,
        cover: s.cover,
        collection_excluded: s.collection ? [...s.excluded] : null,
        collection_ratings: s.collection ? { ...s.ratings } : null,
        members: s.collection ? [] : [...s.members],
      };
    },
  };
}
