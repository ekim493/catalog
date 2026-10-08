// Entry mutations shared by the Ledger, Tracker and forms. Every
// undoable action snapshots the fields it touches plus date_modified BEFORE
// mutating; the undo PATCH sends them back verbatim so the entry looks as if
// the action never happened.

import { API } from "../core/api.js";
import { applyResult, removeEntry } from "../core/store.js";
import { isTerminal, isGroup } from "../core/model.js";
import { statusLabel, todayISO, verbs } from "../core/format.js";
import { toast, toastError } from "../ui/toast.js";
import { confirm } from "../ui/modal.js";

// One busy flag per action type: a double tap is ignored, but acting on two
// different cards with different actions still works.
const busy = new Set();

async function once(kind, fn) {
  if (busy.has(kind)) return null;
  busy.add(kind);
  try {
    return await fn();
  } finally {
    busy.delete(kind);
  }
}

function snapshot(entry, keys) {
  const prev = { date_modified: entry.date_modified };
  for (const key of keys) prev[key] = entry[key] ?? null;
  return prev;
}

async function undoPatch(id, prev) {
  try {
    applyResult(await API.update(id, prev));
    toast("Undone.");
  } catch (err) {
    toastError(err);
  }
}

export function patchWithUndo(entry, patch, message, { kind = "edit", alsoRestore = [] } = {}) {
  return once(kind, async () => {
    const prev = snapshot(entry, [...Object.keys(patch), ...alsoRestore]);
    try {
      const result = applyResult(await API.update(entry.id, patch));
      toast(message, { undo: () => undoPatch(entry.id, prev) });
      return result;
    } catch (err) {
      toastError(err);
      return null;
    }
  });
}

export function setStatus(entry, status, { progress, message } = {}) {
  const patch = { status };
  // The client's own calendar day, so a completion reflects the user's
  // "today" whatever the server's timezone.
  if (isTerminal(status) && entry.status !== status) patch.date_complete = todayISO();
  if (progress) patch.progress = progress;
  const text = message || (status === "finished" ? "Marked as finished." : `${statusLabel(status)}.`);
  return patchWithUndo(entry, patch, text, { kind: "status", alsoRestore: ["date_complete", "progress"] });
}

export function markProgress(entry, point, message) {
  const unit = verbs(entry.type).done;
  return patchWithUndo(entry, { progress: point }, message || `Marked ${unit}.`, { kind: "progress" });
}

export function rate(entry, rating, member) {
  if (member) {
    const ratings = { ...(entry.collection_ratings || {}) };
    if (rating == null) delete ratings[member.ref];
    else ratings[member.ref] = rating;
    return patchWithUndo(entry, { collection_ratings: ratings },
      rating == null ? "Rating cleared." : `Rated ${rating}/10.`, { kind: "rate" });
  }
  return patchWithUndo(entry, { rating }, rating == null ? "Rating cleared." : `Rated ${rating}/10.`, { kind: "rate" });
}

export function setPinned(entry, pinned) {
  return patchWithUndo(entry, { pinned }, pinned ? "Pinned." : "Unpinned.", { kind: "pin" });
}

export async function setIgnored(entry, ignored, { ask = true } = {}) {
  if (ignored && ask && !(await confirm({
    title: "Ignore this show?",
    message: `"${entry.title}" will be hidden from the Tracker. You can restore it from its Edit form.`,
    confirmLabel: "Ignore",
  }))) return null;
  return patchWithUndo(entry, { ignored }, ignored ? `Ignoring "${entry.title}".` : "No longer ignored.", { kind: "ignore" });
}

export function setSpecials(entry, refs) {
  return patchWithUndo(entry, { specials_watched: refs }, "Specials updated.", { kind: "specials" });
}

export function setChapterOverride(entry, value) {
  return patchWithUndo(entry, { chapter_override: value },
    value == null ? "Latest-chapter override cleared." : `Latest chapter set to Ch ${value}.`, { kind: "override" });
}

export function acknowledge(entry, value = true) {
  return once("ack", async () => {
    try {
      const result = applyResult(await API.acknowledge(entry.id, value));
      toast(value ? "Acknowledged." : "Undone.", value ? { undo: () => acknowledge(entry, false) } : {});
      return result;
    } catch (err) {
      toastError(err);
      return null;
    }
  });
}

export async function deleteEntry(entry) {
  const ok = await confirm({
    title: isGroup(entry) ? "Delete group?" : "Delete entry?",
    message: isGroup(entry)
      ? `Delete the group "${entry.title}"? Its entries stay in your catalog, just no longer grouped.`
      : `Delete "${entry.title}"? A backup of the catalog is kept automatically, but this can't be undone from the app.`,
    confirmLabel: "Delete", danger: true,
  });
  if (!ok) return false;
  try {
    await API.remove(entry.id);
    removeEntry(entry.id);
    toast(isGroup(entry) ? "Group deleted." : "Entry deleted.");
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}
