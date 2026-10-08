// Boot, navigation, and app-wide shortcuts.

import { API } from "./core/api.js";
import { h, icon, iconButton } from "./core/dom.js";
import { navigate } from "./core/nav.js";
import { loadTracker, prefs, setConfig, setEntries, state } from "./core/store.js";
import { toastError } from "./ui/toast.js";
import { openEntryForm } from "./features/entry-form.js";
import { applyTheme, offerImport, openSettings } from "./features/settings.js";
import * as ledger from "./views/ledger.js";
import * as tracker from "./views/tracker.js";
import * as stash from "./views/stash.js";
import * as stats from "./views/stats.js";

const VIEWS = [
  { id: "ledger", label: "Ledger", icon: "ledger", module: ledger },
  { id: "tracker", label: "Tracker", icon: "tracker", module: tracker },
  { id: "stash", label: "Stash", icon: "stash", module: stash },
  { id: "stats", label: "Stats", icon: "stats", module: stats },
];
let current = null;

function buildChrome() {
  const nav = document.querySelector("[data-nav]");
  const tabbar = document.querySelector("[data-tabbar]");
  const tab = (v) => h("a", { class: "tab-link", href: `#/${v.id}`, dataset: { view: v.id } }, icon(v.icon, 21), v.label);
  for (const v of VIEWS) {
    nav.append(h("a", { class: "nav-link", href: `#/${v.id}`, dataset: { view: v.id } }, icon(v.icon), v.label));
  }
  // Phones: Add sits in the middle of the tab bar, where the thumb rests;
  // Settings is rarely needed, so it lives in the top bar instead.
  const tabs = VIEWS.map(tab);
  tabbar.append(...tabs.slice(0, 2),
    h("button", { type: "button", class: "tab-add", "aria-label": "Add entry", onClick: () => openEntryForm() },
      h("span", { class: "tab-add-mark" }, icon("plus", 24))),
    ...tabs.slice(2));
  document.querySelector(".topbar").append(iconButton("settings", "Settings", openSettings, { class: "topbar-settings", size: 21 }));
  const settingsBtn = document.querySelector("[data-action=settings]");
  settingsBtn.append(icon("settings"), "Settings");
  settingsBtn.addEventListener("click", openSettings);
  document.querySelector("[data-action=add]").addEventListener("click", () => openEntryForm());
  document.querySelector("[data-version]").textContent = `v${state.config.version}`;
}

function parseHash() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const id = VIEWS.some((v) => v.id === path) ? path : prefs.get("view", "ledger");
  return { id, params: Object.fromEntries(new URLSearchParams(query || "")) };
}

function route() {
  const { id, params } = parseHash();
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  for (const v of VIEWS) document.getElementById(`view-${v.id}`).hidden = v !== view;
  for (const link of document.querySelectorAll("[data-view]")) {
    link.classList.toggle("active", link.dataset.view === view.id);
  }
  if (current !== view) window.scrollTo(0, 0);
  current = view;
  prefs.set("view", view.id);
  view.module.activate(params);
}

// Desktop shortcuts: "/" searches the Ledger, "n" adds an entry.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.body.classList.contains("modal-open")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable) return;
  // Letters in an open menu or on a dropdown are type-ahead, as in a native select.
  if (e.target.closest(".menu-panel, .dropdown-btn")) return;
  if (e.key === "/") {
    e.preventDefault();
    // From another view, focus once the route has un-hidden the Ledger.
    if (current && current.id === "ledger") ledger.focusSearch();
    else {
      window.addEventListener("hashchange", () => ledger.focusSearch(), { once: true });
      navigate("ledger");
    }
  } else if (e.key === "n") {
    e.preventDefault();
    openEntryForm();
  }
});

async function boot() {
  applyTheme();
  let config, entries;
  try {
    [config, entries] = await Promise.all([API.config(), API.entries()]);
  } catch (err) {
    document.querySelector(".main").replaceChildren(
      h("div", { class: "empty" }, h("div", { class: "empty-title" }, "Catalog couldn't load"), err.message));
    return;
  }
  setConfig(config);
  setEntries(entries);
  buildChrome();
  for (const v of VIEWS) v.module.mount(document.getElementById(`view-${v.id}`));
  window.addEventListener("hashchange", route);
  route();
  // The Ledger's "Show in tracker" needs Tracker items for finished entries.
  loadTracker().catch(() => {});
  if (config.fresh_start && !entries.length) offerImport();
}

boot().catch((err) => {
  console.error(err);
  toastError(err);
});
