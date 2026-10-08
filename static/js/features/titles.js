// Main title / synonym options. For linked AniList and TMDb entries the
// source's alternate titles are offered as presets; a custom synonym is
// always possible. No synonym is ever chosen automatically.

import { API } from "../core/api.js";
import { h } from "../core/dom.js";
import { applyResult, hasAltTitles } from "../core/store.js";
import { openModal } from "../ui/modal.js";
import { toast, toastError } from "../ui/toast.js";

/**
 * openTitleOptions({ entry }) edits a saved entry's synonym directly.
 * openTitleOptions({ form: { title, synonym, link } }) resolves
 * { title } | { synonym } | null for the entry form to apply.
 */
export function openTitleOptions({ entry, form, mode }) {
  const link = entry ? entry.link : form.link;
  const mainTitle = entry ? entry.title : form.title;
  const current = entry ? entry.synonym || null : form.synonym;
  const hasTitles = !!(link && link.id && hasAltTitles(link.source));
  let tab = mode || (form && hasTitles ? "main" : "synonym");
  let titles = null;
  let error = null;

  const tabs = h("div", { class: "segmented segmented-full", hidden: !(form && hasTitles) });
  const help = h("p", { class: "modal-message muted" });
  const customInput = h("input", { class: "input", type: "text", value: current || "", placeholder: "Enter your own synonym", autocomplete: "off" });
  const custom = h("form", { class: "field", onSubmit: (e) => { e.preventDefault(); apply({ synonym: customInput.value.trim() || null }); } },
    h("span", { class: "field-label" }, "Custom synonym"),
    h("div", { class: "inline-row" }, customInput, h("button", { type: "submit", class: "btn btn-ghost" }, "Set")));
  const clearBtn = h("button", { type: "button", class: "btn btn-ghost danger clear-synonym",
    onClick: () => apply({ synonym: null }) }, "Clear synonym");
  const list = h("div", { class: "choice-list" });

  const modal = openModal({ title: form ? "Titles" : "Synonym", size: "md", content: [tabs, help, custom, list, clearBtn] });

  async function apply(result) {
    if (form) return modal.close(result);
    modal.close();
    try {
      applyResult(await API.update(entry.id, { synonym: result.synonym }));
      toast(result.synonym ? "Synonym saved." : "Synonym cleared.");
    } catch (err) {
      toastError(err);
    }
  }

  function render() {
    tabs.replaceChildren(...[["main", "Main title"], ["synonym", "Synonym"]].map(([key, label]) =>
      h("button", { type: "button", class: tab === key ? "active" : null, onClick: () => { tab = key; render(); } }, label)));
    help.textContent = tab === "main"
      ? "Choose which source title to use as the entry's main title."
      : "The synonym appears beneath the main title and is included in Ledger search.";
    custom.hidden = tab !== "synonym";
    clearBtn.hidden = tab !== "synonym" || !current;
    const rows = [];
    if (hasTitles) {
      if (error) rows.push(h("p", { class: "inline-note pick-message" }, error));
      else if (!titles) rows.push(h("p", { class: "loading" }, "Fetching titles…"));
      else if (!titles.length) rows.push(h("p", { class: "inline-note pick-message" }, "The source lists no other titles."));
      else {
        rows.push(h("div", { class: "choice-heading" }, "From the source"));
        for (const t of titles) {
          const isMain = t.title === mainTitle;
          const isSynonym = t.title === current;
          // The value this tab sets is filled; the main title can't also be
          // the synonym, so it greys out there.
          const selected = tab === "main" ? isMain : isSynonym;
          const unavailable = tab === "synonym" && isMain;
          rows.push(h("button", { type: "button", class: ["choice", selected && "selected", unavailable && "unavailable"],
            disabled: selected || unavailable,
            onClick: () => apply(tab === "main" ? { title: t.title } : { synonym: t.title }) },
            h("span", { class: "choice-title" }, t.title),
            h("span", { class: "choice-meta" }, isMain ? "Main title" : isSynonym ? "Synonym" : t.label)));
        }
      }
    }
    list.replaceChildren(...rows);
    list.hidden = !rows.length;
  }

  render();
  if (hasTitles) {
    API.titles(link.source, link.id).then((res) => { titles = res.titles || []; }, (err) => { error = err.message; })
      .then(() => { if (!modal.closed) render(); });
  }
  return modal.result.then((r) => r || null);
}
