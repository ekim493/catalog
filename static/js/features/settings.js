// Settings, theme, and backup export/import.

import { API } from "../core/api.js";
import { h } from "../core/dom.js";
import { emit, prefs, setEntries, state } from "../core/store.js";
import { confirm, openModal } from "../ui/modal.js";
import { toast, toastError } from "../ui/toast.js";
import { dropdown } from "../ui/dropdown.js";

const THEME_COLORS = { light: "#F0ECE0", dark: "#221D17", amoled: "#000000" };
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme() {
  const choice = prefs.get("theme", "system");
  if (choice in THEME_COLORS) return choice;
  return systemDark.matches ? "dark" : "light";
}

// AMOLED is the dark theme plus a flag, so every dark-mode rule applies to it.
export function applyTheme() {
  const theme = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = theme === "light" ? "light" : "dark";
  if (theme === "amoled") root.dataset.amoled = "";
  else delete root.dataset.amoled;
  document.querySelector('meta[name="theme-color"]').content = THEME_COLORS[theme];
}
systemDark.addEventListener("change", applyTheme);

function segmented(options, value, onPick) {
  const wrap = h("div", { class: "segmented" });
  const draw = (current) => wrap.replaceChildren(...options.map(([v, label]) =>
    h("button", { type: "button", class: v === current ? "active" : null, onClick: () => { onPick(v); draw(v); } }, label)));
  draw(value);
  return wrap;
}

function selectPref(options, key, fallback, onChange) {
  const current = String(prefs.get(key, fallback));
  const el = h("select", { class: "select" }, options.map(([v, label]) => h("option", { value: v, selected: String(v) === current }, label)));
  el.addEventListener("change", () => onChange(el.value));
  return dropdown(el);
}

async function exportBackup() {
  if (await confirm({ title: "Export backup?", message: "This downloads a dated JSON snapshot of your full catalog.", confirmLabel: "Download" })) {
    window.location.href = "/api/export";
  }
}

async function importFile(file, modal) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    return toast("That file isn't valid JSON.");
  }
  try {
    const res = await API.importEntries(data);
    modal.close();
    setEntries(await API.entries());
    toast(`Imported ${res.imported} ${res.imported === 1 ? "entry" : "entries"} — artwork and details are rebuilding in the background.`);
  } catch (err) {
    toastError(err);
  }
}

function importControl(modal) {
  const input = h("input", { type: "file", accept: ".json,application/json", class: "input" });
  return h("div", { class: "field" }, input,
    h("button", { type: "button", class: "btn btn-primary", onClick: () => {
      if (!input.files[0]) return toast("Choose a backup file first.");
      importFile(input.files[0], modal);
    } }, "Load backup"));
}

export function offerImport() {
  openModal({
    title: "Welcome to Catalog", size: "sm",
    content: (m) => [
      h("p", { class: "modal-message" }, "Starting fresh? If you have a backup (an entries.json or an exported file), load it now — artwork and details rebuild automatically."),
      importControl(m),
    ],
    actions: [{ label: "Start fresh", value: undefined }],
  });
}

export function openSettings() {
  openModal({
    title: "Settings", size: "sm",
    content: (m) => [
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Appearance"),
        segmented([["light", "Light"], ["dark", "Dark"], ["amoled", "AMOLED"], ["system", "System"]], prefs.get("theme", "system"),
          (v) => { prefs.set("theme", v); applyTheme(); })),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Date shown in the Ledger"),
        selectPref([["relevant", "Relevant (completed, else added)"], ["added", "Always date added"], ["released", "Date released"]],
          "ledger.dateMode", "relevant", (v) => { prefs.set("ledger.dateMode", v); emit("prefs"); })),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Entries per page"),
        selectPref([[25, "25"], [50, "50"], [100, "100"], ["all", "All"]], "ledger.pageSize", 50,
          (v) => { prefs.set("ledger.pageSize", v === "all" ? "all" : Number(v)); emit("prefs"); })),
      h("div", { class: "settings-section" },
        h("div", { class: "inline-row" }, h("button", { type: "button", class: "btn btn-ghost", onClick: exportBackup }, "Export backup")),
        state.entries.length ? null : h("div", { class: "field" }, h("span", { class: "field-label" }, "Import a backup"), importControl(m))),
      h("div", { class: "settings-foot" },
        h("span", null, `Catalog v${state.config.version}`),
        h("span", { class: "keyboard-only" }, "Keyboard: / to search, n to add an entry")),
    ],
  });
}
