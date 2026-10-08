import { h, icon } from "../core/dom.js";
import { TYPE_ICONS } from "../core/format.js";

// A 2:3 poster thumbnail, or a type icon when there's no artwork.
export function poster(url, { size = "sm", type, className } = {}) {
  if (url) {
    return h("div", { class: ["poster", `poster-${size}`, className] },
      h("img", { src: url, alt: "", loading: "lazy", decoding: "async" }));
  }
  return h("div", { class: ["poster", "poster-empty", `poster-${size}`, className] },
    icon(TYPE_ICONS[type] || "box", size === "sm" ? 16 : 22));
}
