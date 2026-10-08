import { h, icon } from "../core/dom.js";

let timer = null;

// toast("Saved.") or toast("Dropped.", { undo: async () => ... })
export function toast(message, { undo, duration } = {}) {
  const root = document.getElementById("toast-root");
  clearTimeout(timer);
  const hide = () => el.classList.remove("visible");
  const el = h("div", { class: "toast", role: "status" },
    h("span", { class: "toast-message" }, message),
    undo ? h("button", { type: "button", class: "toast-undo", onClick: async (e) => {
      e.currentTarget.disabled = true;
      hide();
      clearTimeout(timer);
      await undo();
    } }, icon("undo", 15), "Undo") : null);
  root.replaceChildren(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  timer = setTimeout(hide, duration || (undo ? 5000 : 2600));
}

export function toastError(err) {
  toast(err && err.message ? err.message : String(err));
}
