// Modal stack. Escape and overlay clicks close only the topmost layer, so a
// dialog opened from a form never discards the form beneath it.

import { h, iconButton } from "../core/dom.js";

const escapeStack = [];
let openCount = 0;

// Transient layers (menus, suggestion lists) register here too, so the
// first Escape closes the innermost thing on screen.
export function onEscape(fn) {
  escapeStack.push(fn);
  return () => {
    const i = escapeStack.lastIndexOf(fn);
    if (i !== -1) escapeStack.splice(i, 1);
  };
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !escapeStack.length) return;
  e.preventDefault();
  escapeStack[escapeStack.length - 1]();
});

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

// Tab cycles within the topmost dialog so focus never reaches the page behind.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const overlays = document.querySelectorAll("#modal-root > .modal-overlay:not(.closing)");
  const dialog = overlays.length ? overlays[overlays.length - 1].querySelector(".modal") : null;
  if (!dialog) return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length);
  const current = document.activeElement;
  if (!items.length) {
    e.preventDefault();
    dialog.focus();
  } else if (e.shiftKey && (!dialog.contains(current) || current === items[0] || current === dialog)) {
    e.preventDefault();
    items[items.length - 1].focus();
  } else if (!e.shiftKey && (!dialog.contains(current) || current === items[items.length - 1])) {
    e.preventDefault();
    items[0].focus();
  }
});

let titleIds = 0;

function buildActions(footer, actions, handle) {
  footer.replaceChildren();
  for (const a of actions || []) {
    if (!a) continue;
    const btn = h("button", { type: a.submit ? "submit" : "button",
      class: ["btn", `btn-${a.kind || "ghost"}`, a.class], title: a.title, form: a.form }, a.label);
    if (a.onClick || "value" in a) {
      btn.addEventListener("click", async () => {
        if (a.onClick) await a.onClick(handle);
        else handle.close(a.value);
      });
    }
    footer.append(btn);
  }
  footer.hidden = !footer.children.length;
}

/**
 * openModal({ title, content, actions, size, className, autofocus, onClose })
 * content: Node | Node[] | (modal) => Node. actions: [{ label, kind, value } |
 * { label, kind, onClick(modal) }]. Resolves modal.result with the close value.
 */
export function openModal(opts = {}) {
  const { title = "", size = "md", className, autofocus = true, onClose } = opts;
  let closed = false;
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const previousFocus = document.activeElement;

  const titleEl = h("h2", { class: "modal-title", id: `modal-title-${++titleIds}` }, title);
  const body = h("div", { class: "modal-body" });
  const footer = h("footer", { class: "modal-footer" });
  const header = h("header", { class: "modal-header" }, titleEl, iconButton("close", "Close", () => handle.close()));
  const dialog = h("div", { class: ["modal", `modal-${size}`, className], role: "dialog",
    "aria-modal": "true", "aria-labelledby": titleEl.id, tabindex: "-1" }, header, body, footer);
  const overlay = h("div", { class: "modal-overlay" }, dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) handle.close();
  });

  const handle = {
    el: dialog, body, footer, result,
    get closed() { return closed; },
    setTitle(text) { titleEl.textContent = text; },
    setContent(...nodes) { body.replaceChildren(...nodes.flat().filter(Boolean)); },
    close(value) {
      if (closed) return;
      closed = true;
      removeEscape();
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 160);
      openCount -= 1;
      document.body.classList.toggle("modal-open", openCount > 0);
      if (onClose) onClose(value);
      resolve(value);
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
    },
  };
  const removeEscape = onEscape(() => handle.close());

  const content = typeof opts.content === "function" ? opts.content(handle) : opts.content;
  if (content) handle.setContent(content);
  buildActions(footer, opts.actions, handle);

  document.getElementById("modal-root").append(overlay);
  openCount += 1;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    const visible = (sel) => [...dialog.querySelectorAll(sel)].find((el) => el.getClientRects().length);
    const target = autofocus && (visible("[autofocus]") ||
      (window.matchMedia("(pointer: fine)").matches && visible("input:not([type=hidden]), textarea")));
    (target || dialog).focus({ preventScroll: true });
  });
  return handle;
}

export function confirm({ title = "Are you sure?", message = "", confirmLabel = "Confirm",
  cancelLabel = "Cancel", danger = false } = {}) {
  const modal = openModal({
    title, size: "sm",
    content: h("p", { class: "modal-message" }, message),
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, kind: danger ? "danger" : "primary", value: true },
    ],
  });
  return modal.result.then((v) => v === true);
}

// Several labelled outcomes: resolves the chosen value, or null on dismiss.
export function choose({ title, message, options }) {
  const modal = openModal({
    title, size: "sm",
    content: h("p", { class: "modal-message" }, message),
    actions: options.map((o) => ({ label: o.label, kind: o.kind || "ghost", value: o.value })),
  });
  return modal.result.then((v) => (v === undefined ? null : v));
}
