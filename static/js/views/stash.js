// The Stash: titles spotted somewhere and worth remembering, kept apart from
// the catalog. "Add to catalog" opens a prefilled Add form and removes the
// item once that entry saves.

import { API } from "../core/api.js";
import { clear, h, sequence } from "../core/dom.js";
import { TYPES, fmtDateShort, typeOrder } from "../core/format.js";
import { state } from "../core/store.js";
import { menuButton } from "../ui/menu.js";
import { openModal } from "../ui/modal.js";
import { toast, toastError } from "../ui/toast.js";
import { openEntryForm } from "../features/entry-form.js";
import { dropdown } from "../ui/dropdown.js";

// Trailing punctuation stays out of the link ("see https://x.com/a.").
const URL_RE = /(https?:\/\/[^\s<>"]*[^\s<>"'.,;:!?)\]])/g;
const MAX_TEXT = 5000;

let list, subtitle, jotText, jotType, jotBtn;
let items = [];
let loaded = false;
let adding = false;
// Local changes invalidate it, so a load that started earlier can't undo them.
const seq = sequence();

function typeChoices(selected) {
  const custom = [...new Set(state.entries.map((e) => e.type))].filter((t) => !TYPES.includes(t) && t !== "Group");
  const types = typeOrder(custom).filter((t) => t !== "Group");
  if (selected && !types.includes(selected)) types.push(selected);
  return [h("option", { value: "" }, "No type"),
    ...types.map((t) => h("option", { value: t, selected: t === selected }, t))];
}

function submitOnModEnter(fn) {
  return (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fn();
    }
  };
}

export function mount(section) {
  subtitle = h("div", { class: "view-subtitle" });
  jotText = h("textarea", { class: "input", rows: 2, maxlength: MAX_TEXT, "aria-label": "Something to stash",
    placeholder: "Title, link or note", onKeydown: submitOnModEnter(add) });
  jotType = h("select", { class: "select stash-jot-type", "aria-label": "Type" }, typeChoices(""));
  jotBtn = h("button", { type: "submit", class: "btn btn-primary" }, "Add to stash");
  list = h("div", null, h("div", { class: "loading" }, "Loading your stash…"));
  clear(section,
    h("header", { class: "view-header" }, h("div", h("h1", { class: "view-title" }, "Stash"), subtitle)),
    h("form", { class: "card stash-jot", onSubmit: (e) => { e.preventDefault(); add(); } },
      jotText, h("div", { class: "stash-jot-row" }, dropdown(jotType), jotBtn)),
    list);
}

export function activate() {
  // Custom types may have appeared since the last visit.
  jotType.replaceChildren(...typeChoices(jotType.value));
  refresh();
}

async function refresh() {
  const token = seq.next();
  try {
    const data = await API.stash();
    if (!seq.isCurrent(token)) return;
    items = data.items || [];
    loaded = true;
    render();
  } catch (err) {
    if (!seq.isCurrent(token)) return;
    if (loaded) return toastError(err);
    clear(list, h("div", { class: "empty" },
      h("div", { class: "empty-title" }, "Couldn't load your stash"), err.message,
      h("div", { class: "empty-action" }, h("button", { type: "button", class: "btn btn-sm", onClick: refresh }, "Retry"))));
  }
}

function render() {
  subtitle.textContent = items.length ? `${items.length} ${items.length === 1 ? "item" : "items"} stashed` : "";
  if (!items.length) {
    clear(list, h("div", { class: "empty" }, h("div", { class: "empty-title" }, "Nothing stashed yet")));
    return;
  }
  clear(list, h("div", { class: "stash-cards" }, items.map(card)));
}

function linkify(text) {
  return text.split(URL_RE).map((part, i) => (i % 2
    ? h("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part)
    : part));
}

function card(item) {
  const [first, ...rest] = item.text.split("\n");
  const more = rest.join("\n").trim();
  return h("article", { class: "card stash-card", dataset: { id: item.id } },
    h("div", { class: "stash-card-body" },
      h("div", { class: "stash-title" }, linkify(first)),
      more ? h("div", { class: "stash-more" }, linkify(more)) : null,
      h("div", { class: "stash-meta" },
        item.type ? h("span", { class: "tag stash-type" }, item.type) : null,
        h("span", { class: "stash-date" }, `Added ${fmtDateShort(item.date_added)}`))),
    h("div", { class: "stash-card-actions" },
      h("button", { type: "button", class: "btn btn-primary btn-sm", title: "Open the Add entry form with this filled in",
        onClick: () => promote(item) }, "Add to catalog"),
      menuButton([
        { label: "Edit", onClick: () => edit(item) },
        { label: "Delete", danger: true, onClick: () => remove(item) },
      ], { label: "More", class: "btn btn-ghost btn-sm" })));
}

// ---------------------------------------------------------------- actions

function show(next) {
  seq.invalidate();
  items = next.sort((a, b) => String(b.date_added).localeCompare(String(a.date_added)));
  render();
}

async function add() {
  const text = jotText.value.trim();
  if (!text) return jotText.focus();
  if (adding) return;
  adding = true;
  jotBtn.disabled = true;
  try {
    const { item } = await API.stashItem({ text, type: jotType.value || null });
    jotText.value = "";
    show([item, ...items.filter((i) => i.id !== item.id)]);
    toast("Stashed.");
  } catch (err) {
    toastError(err);
  } finally {
    adding = false;
    jotBtn.disabled = false;
  }
}

async function restore(item) {
  try {
    const { item: back } = await API.stashItem(item);
    show([back, ...items.filter((i) => i.id !== back.id)]);
    toast("Undone.");
  } catch (err) {
    toastError(err);
  }
}

async function remove(item, message = "Deleted from your stash.") {
  try {
    await API.removeStashItem(item.id);
    show(items.filter((i) => i.id !== item.id));
    toast(message, { undo: () => restore(item) });
  } catch (err) {
    toastError(err);
  }
}

// The first line becomes the title, minus any links, which move to the notes
// with the rest of the text.
async function promote(item) {
  const [first, ...rest] = item.text.split("\n");
  const links = first.match(URL_RE) || [];
  const title = first.replace(URL_RE, "").replace(/\s+/g, " ").trim();
  const notes = [...(title ? links : []), ...rest].join("\n").trim();
  const modal = openEntryForm(null, { title: title || first.trim(), type: item.type, notes, status: "planned" });
  if (await modal.result) remove(item, "Added to your catalog and removed from your stash.");
}

function edit(item) {
  const text = h("textarea", { class: "input", rows: 5, maxlength: MAX_TEXT, onKeydown: submitOnModEnter(() => save()) }, item.text);
  const type = h("select", { class: "select" }, typeChoices(item.type || ""));
  let saving = false;
  const modal = openModal({
    title: "Edit stashed item",
    content: h("div", { class: "stash-edit" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Note"), text),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Type"), dropdown(type))),
    actions: [{ label: "Cancel", value: undefined }, { label: "Save", kind: "primary", onClick: () => save() }],
  });

  async function save() {
    if (saving) return;
    if (!text.value.trim()) return toast("Write something first.");
    saving = true;
    try {
      const { item: updated } = await API.updateStashItem(item.id, { text: text.value, type: type.value || null });
      show(items.map((i) => (i.id === updated.id ? updated : i)));
      modal.close();
      toast("Stashed item updated.");
    } catch (err) {
      toastError(err);
    } finally {
      saving = false;
    }
  }
}
