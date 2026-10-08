// Dropdowns drawn with the app's menu. The hidden <select> stays the source
// of truth (value, options, hidden/disabled, "change"); the button mirrors it.

import { h } from "../core/dom.js";
import { bindMenu } from "./menu.js";

const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
const INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");

// dropdown(h("select", …)) -> an element to insert in place of the select.
export function dropdown(select) {
  const label = h("span", { class: "dropdown-label" });
  const button = h("button", { type: "button", class: [select.className, "dropdown-btn"],
    title: select.title || null, "aria-label": select.getAttribute("aria-label") }, label);
  const wrap = h("span", { class: "dropdown" }, button, select);

  const sync = () => {
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.textContent : "";
    button.disabled = select.disabled;
    wrap.hidden = select.hidden;
  };
  // Assigning .value or .selectedIndex fires no event, so mirror it here.
  for (const [prop, native] of [["value", VALUE], ["selectedIndex", INDEX]]) {
    Object.defineProperty(select, prop, { configurable: true,
      get() { return native.get.call(this); },
      set(v) { native.set.call(this, v); sync(); } });
  }
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
  select.addEventListener("change", sync);

  bindMenu(button, () => [...select.options].map((opt) => ({
    label: opt.textContent, selected: opt.selected, disabled: opt.disabled,
    onClick: () => {
      if (opt.selected) return;
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
  })), { align: "start" });
  sync();
  return wrap;
}
