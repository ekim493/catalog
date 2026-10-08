// Menus: the More / ⋯ action menus and the app's dropdowns (ui/dropdown.js).
// The panel is positioned fixed against its button, so it is never clipped
// by a card or scroll container.

import { h, icon } from "../core/dom.js";
import { onEscape } from "./modal.js";

// Fixed lists fit in 12 rows; longer ones scroll, with a half row as the cue.
const MAX_ROWS = 12;
let active = null;

function closeActive() {
  if (!active) return;
  const { panel, button } = active;
  // Keyboard users land back on the button rather than on the page.
  const hadFocus = panel.contains(document.activeElement);
  panel.remove();
  button.setAttribute("aria-expanded", "false");
  active.removeEscape();
  active = null;
  if (hadFocus) button.focus({ preventScroll: true });
}

document.addEventListener("click", (e) => {
  if (active && !active.panel.contains(e.target) && !active.button.contains(e.target)) closeActive();
});
// iOS toolbars resize the viewport height while scrolling; only width matters.
window.addEventListener("resize", () => { if (active && window.innerWidth !== active.width) closeActive(); });
// Close on real scrolling only: iOS can nudge the page by a pixel on tap.
document.addEventListener("scroll", () => {
  if (active && Math.abs(active.button.getBoundingClientRect().top - active.top) > 4) closeActive();
}, true);

// Below when it fits, otherwise toward the roomier side, scrolling if the
// menu is taller than that space.
function place(panel, button, align) {
  const rect = button.getBoundingClientRect();
  if (align === "start") panel.style.minWidth = `${rect.width}px`;
  const below = window.innerHeight - rect.bottom - 14;
  const above = rect.top - 14;
  const items = panel.querySelectorAll(".menu-item");
  const cap = items.length > MAX_ROWS ? items[0].offsetHeight * (MAX_ROWS + 0.5) + 8 : Infinity;
  const down = Math.min(panel.offsetHeight, cap) <= below || below >= above;
  panel.style.maxHeight = `${Math.max(0, Math.min(cap, down ? below : above))}px`;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = align === "start" ? rect.left : rect.right - width;
  panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  panel.style.top = `${down ? rect.bottom + 6 : rect.top - height - 6}px`;
  const current = panel.querySelector(".menu-item.selected");
  if (current) panel.scrollTop = current.offsetTop - (panel.clientHeight - current.offsetHeight) / 2;
}

function menuItems() {
  return active ? [...active.panel.querySelectorAll(".menu-item:not(:disabled)")] : [];
}

function focusItem(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

// "start" focuses the current choice (dropdowns) or the first item.
function focusStart(which = "start") {
  const items = menuItems();
  focusItem(which === "last" ? items[items.length - 1]
    : active.panel.querySelector(".menu-item.selected:not(:disabled)") || items[0]);
}

function onPanelKey(e) {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown") next = items[(i + 1) % items.length];
  else if (e.key === "ArrowUp") next = items[i <= 0 ? items.length - 1 : i - 1];
  else if (e.key === "Home") next = items[0];
  else if (e.key === "End") next = items[items.length - 1];
  else if (e.key === "Tab") return closeActive();
  else if (e.key.length === 1 && e.key.trim() && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // Type-ahead: the next item starting with that letter.
    const key = e.key.toLowerCase();
    next = [...items.slice(i + 1), ...items.slice(0, i + 1)]
      .find((el) => el.textContent.trim().toLowerCase().startsWith(key));
  }
  if (!next) return;
  e.preventDefault();
  focusItem(next);
}

function open(button, items, { align } = {}) {
  const panel = h("div", { class: "menu-panel", role: "menu", onKeydown: onPanelKey });
  for (const item of items.filter(Boolean)) {
    if (item.divider) panel.append(h("div", { class: "menu-divider" }));
    else if (item.info) panel.append(h("div", { class: "menu-info" }, item.info));
    else {
      const choice = item.selected !== undefined;
      panel.append(h("button", { type: "button", role: choice ? "menuitemradio" : "menuitem", title: item.title,
        "aria-checked": choice ? String(!!item.selected) : null, disabled: !!item.disabled,
        class: ["menu-item", item.danger && "danger", item.selected && "selected"],
        onClick: (ev) => { ev.stopPropagation(); closeActive(); item.onClick(); } }, item.label));
    }
  }
  document.body.append(panel);
  place(panel, button, align);
  button.setAttribute("aria-expanded", "true");
  active = { panel, button, top: button.getBoundingClientRect().top, width: window.innerWidth, removeEscape: onEscape(closeActive) };
}

/**
 * Turns a button into a menu toggle. getItems() runs on each open and returns
 * [{ label, onClick, danger, title, selected, disabled }] | { info: text } |
 * { divider: true }. opts: { align: "start" } for dropdowns.
 */
export function bindMenu(button, getItems, opts = {}) {
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const isOpen = () => !!active && active.button === button;
  button.addEventListener("click", (e) => {
    // Inside a <label>, the click must not also activate the label's control.
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = isOpen();
    closeActive();
    if (wasOpen) return;
    open(button, getItems(), opts);
    // Opened from the keyboard (Enter or Space): move into the menu.
    if (e.detail === 0) focusStart();
  });
  button.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!isOpen()) {
      closeActive();
      open(button, getItems(), opts);
    }
    focusStart(e.key === "ArrowUp" ? "last" : "start");
  });
}

// opts: { label: "More", class, title }
export function menuButton(items, opts = {}) {
  const button = h("button", { type: "button", class: opts.class || (opts.label ? "btn btn-ghost btn-sm" : "icon-btn"),
    title: opts.title || "More actions" },
    opts.label ? [opts.label, icon("chevronDown", 14)] : icon("more", 18));
  bindMenu(button, () => items);
  return button;
}
