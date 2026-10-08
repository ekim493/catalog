// A comic's secondary chapter source (for a more current latest chapter)
// and the manual latest-chapter override.

import { API } from "../core/api.js";
import { debounce, h, sequence } from "../core/dom.js";
import { linkLabel, secondarySource } from "../core/store.js";
import { openModal } from "../ui/modal.js";
import { toast } from "../ui/toast.js";
import { poster } from "../ui/poster.js";
import { setChapterOverride } from "./actions.js";

// Resolves { source, id, title, url } or null.
export function pickChapterSource(query) {
  const src = secondarySource();
  if (!src) return Promise.resolve(null);
  const seq = sequence();
  const input = h("input", { class: "input", type: "search", value: query || "", placeholder: `Search ${src.label}…`, autocomplete: "off" });
  const results = h("div", { class: "choice-list" });
  const modal = openModal({
    title: "Add a chapter source",
    content: [h("p", { class: "modal-message muted" },
      `Link a ${src.label} series to feed this comic's latest chapter. The main link stays as it is.`), input, results],
  });

  async function search() {
    const q = input.value.trim();
    if (q.length < 2) {
      seq.invalidate();
      return results.replaceChildren();
    }
    const token = seq.next();
    results.replaceChildren(h("p", { class: "loading" }, `Searching ${src.label}…`));
    try {
      const { results: found } = await API.search(src.id, q);
      if (!seq.isCurrent(token)) return;
      results.replaceChildren(...(found.length ? found.map((r) => h("button", { type: "button", class: "choice",
        onClick: () => modal.close({ source: src.id, id: r.id, title: r.title, url: r.url }) },
        poster(r.thumb_url, { type: "Comic" }), h("span", { class: "choice-title" }, r.title),
        h("span", { class: "choice-meta" }, r.meta || ""))) : [h("p", { class: "inline-note pick-message" }, `No matches on ${src.label}.`)]));
    } catch (err) {
      if (seq.isCurrent(token)) results.replaceChildren(h("p", { class: "inline-note pick-message" }, err.message));
    }
  }
  input.addEventListener("input", debounce(search, 350));
  if (input.value.length >= 2) search();
  return modal.result.then((r) => r || null);
}

// Resolves the new latest (number), null to clear, or undefined to cancel.
export function promptLatestChapter({ current, sourceLabel, isOverride }) {
  const input = h("input", { class: "input", type: "number", min: 0, step: "any", inputmode: "decimal", value: current ?? "", autofocus: true });
  const save = (m) => {
    const n = parseFloat(input.value);
    if (Number.isNaN(n) || n < 0) return toast("Enter a chapter number.");
    m.close(n);
  };
  const modal = openModal({
    title: "Fix latest chapter", size: "sm",
    content: [
      h("p", { class: "modal-message" }, current != null
        ? `Currently showing Ch ${current}${sourceLabel ? ` (${sourceLabel})` : ""}.`
        : "No latest-chapter data right now — set it yourself."),
      h("form", { class: "field", onSubmit: (e) => { e.preventDefault(); save(modal); } },
        h("span", { class: "field-label" }, "The latest chapter is actually"), input),
    ],
    actions: [
      isOverride ? { label: "Clear override", kind: "quiet", value: null } : null,
      { label: "Cancel", value: undefined },
      { label: "Save", kind: "primary", onClick: save },
    ],
  });
  return modal.result;
}

const LATEST_LABELS = { override: "custom" };

// The Tracker's "Fix latest chapter": saves the override with undo and
// resolves the new latest so an open picker can show its grid.
export async function fixLatestChapter(entry, item) {
  if (!entry) return undefined;
  const source = item && item.latest_source;
  const value = await promptLatestChapter({
    current: item ? item.latest_chapter : entry.chapter_override,
    sourceLabel: source ? LATEST_LABELS[source] || linkLabel(source) : null,
    isOverride: entry.chapter_override != null,
  });
  if (value === undefined) return undefined;
  await setChapterOverride(entry, value);
  return value;
}
