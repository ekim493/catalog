// Quick rating: tap a number to save immediately (with undo).

import { h } from "../core/dom.js";
import { collectionRating } from "../core/model.js";
import { openModal } from "../ui/modal.js";
import { rate } from "./actions.js";

export function ratingScale(current, onPick) {
  return h("div", { class: "rating-scale", role: "group", "aria-label": "Rating" },
    Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
      h("button", { type: "button", class: n === current ? "selected" : null, onClick: () => onPick(n) }, n)));
}

export function openRateDialog(entry, member) {
  const current = member ? collectionRating(entry, member.ref) : entry.rating;
  const modal = openModal({
    title: `Rate "${member ? member.title : entry.title}"`,
    size: "sm",
    content: (m) => ratingScale(current, (n) => { m.close(); rate(entry, n, member); }),
    actions: current != null
      ? [{ label: "Clear rating", kind: "quiet", onClick: (m) => { m.close(); rate(entry, null, member); } }]
      : [],
  });
  return modal.result;
}
