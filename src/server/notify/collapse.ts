// Remove the changes that cancel out, before a notification (#16). See
// "Notifications" in docs/PLAN.md. Input: the events of one person, in
// order. Output: the events that are left, in the order of their first
// event.
//
// Rules, for each item and each list:
//   - Check, then uncheck (or the other way) → nothing. An edit or a move
//     that also unchecked the item (#112) counts as an uncheck too; the edit
//     or the move stays.
//   - Add, then delete → nothing. Delete, then undo (restore) → nothing.
//   - Add, then update or move → only "added" (with the last names).
//   - More than one update → one update. More than one move → one move from
//     the first list to the last list; a move back → nothing.
//   - Create a list, then delete it → nothing, also for its items.
//   - Create, then rename → "created" with the new name. Renames that end at
//     the first name → nothing.
// Bulk events (delete checked, uncheck all, check all) stay.
import type { ActivityEvent } from "./types";

const ITEM_TYPES = new Set([
  "addItem",
  "updateItem",
  "check",
  "uncheck",
  "deleteItem",
  "restoreItem",
  "moveItem",
]);
const LIST_TYPES = new Set([
  "createList",
  "renameList",
  "deleteList",
  "restoreList",
]);

/** True for an uncheck, also an edit or a move that unchecked (#112). */
function unchecks(e: ActivityEvent): boolean {
  return e.type === "uncheck" || e.snapshot.unchecked === true;
}

/** The check and uncheck events, with the edits that unchecked. */
function checkEvents(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.type === "check" || unchecks(e));
}

/** The last event of a group, with the names of the last event. */
function withLastNames(
  event: ActivityEvent,
  last: ActivityEvent,
): ActivityEvent {
  return {
    ...event,
    listId: last.listId,
    snapshot: { ...event.snapshot, ...last.snapshot },
  };
}

/** Keep a delete or a restore only if the deleted state changed. */
function netDelete(
  events: ActivityEvent[],
  deleteType: string,
): ActivityEvent | null {
  const flips = events.filter(
    (e) =>
      e.type === deleteType ||
      e.type === deleteType.replace("delete", "restore"),
  );
  if (flips.length === 0) return null;
  const startedDeleted = flips[0].type !== deleteType;
  const endsDeleted = flips.at(-1)!.type === deleteType;
  return startedDeleted === endsDeleted ? null : flips.at(-1)!;
}

function collapseItem(events: ActivityEvent[]): ActivityEvent[] {
  const last = events.at(-1)!;
  const add = events.find((e) => e.type === "addItem");
  const del = netDelete(events, "deleteItem");

  if (add) {
    // A new item that is gone again: nothing to say.
    if (del?.type === "deleteItem") return [];
    const out = [withLastNames(add, last)];
    // A new item starts unchecked. Say "checked" only if it ends checked.
    const checks = checkEvents(events);
    if (checks.at(-1)?.type === "check")
      out.push(withLastNames(checks.at(-1)!, last));
    return out;
  }

  const out: ActivityEvent[] = [];
  const updates = events.filter((e) => e.type === "updateItem");
  if (updates.length > 0) {
    const fields = [
      ...new Set(updates.flatMap((e) => e.snapshot.fields ?? [])),
    ];
    out.push({
      ...withLastNames(updates.at(-1)!, last),
      snapshot: {
        ...updates.at(-1)!.snapshot,
        listName: last.snapshot.listName,
        oldName: updates[0].snapshot.oldName,
        ...(fields.length > 0 && { fields }),
      },
    });
  }

  const moves = events.filter((e) => e.type === "moveItem");
  if (moves.length > 0) {
    const from = moves[0].snapshot.fromListName;
    const lastMove = moves.at(-1)!;
    if (from !== lastMove.snapshot.listName) {
      out.push({
        ...lastMove,
        snapshot: { ...lastMove.snapshot, fromListName: from },
      });
    }
  }

  const checks = checkEvents(events);
  if (checks.length > 0) {
    const startedChecked = unchecks(checks[0]);
    const endsChecked = checks.at(-1)!.type === "check";
    const final = checks.at(-1)!;
    // An edit or a move that unchecked is in `out` already.
    if (
      startedChecked !== endsChecked &&
      (final.type === "check" || final.type === "uncheck")
    )
      out.push(withLastNames(final, last));
  }

  if (del) {
    // A removed item: the other changes do not matter.
    if (del.type === "deleteItem") return [withLastNames(del, last)];
    out.push(withLastNames(del, last));
  }
  return out;
}

function collapseList(events: ActivityEvent[]): ActivityEvent[] {
  const last = events.at(-1)!;
  const create = events.find((e) => e.type === "createList");
  const del = netDelete(events, "deleteList");

  if (create) {
    if (del?.type === "deleteList") return [];
    return [withLastNames(create, last)];
  }
  if (del?.type === "deleteList") return [withLastNames(del, last)];

  const out: ActivityEvent[] = [];
  const renames = events.filter((e) => e.type === "renameList");
  if (renames.length > 0) {
    const oldName = renames[0].snapshot.oldName;
    const lastRename = renames.at(-1)!;
    if (oldName !== lastRename.snapshot.listName) {
      out.push({
        ...lastRename,
        snapshot: { ...lastRename.snapshot, oldName },
      });
    }
  }
  if (del) out.push(withLastNames(del, last));
  return out;
}

export function collapse(events: ActivityEvent[]): ActivityEvent[] {
  // Lists that this burst made and deleted: drop everything on them.
  const listGroups = new Map<string, ActivityEvent[]>();
  const itemGroups = new Map<string, ActivityEvent[]>();
  const kept: { first: number; events: ActivityEvent[] }[] = [];

  for (const e of events) {
    if (LIST_TYPES.has(e.type)) {
      const group = listGroups.get(e.listId) ?? [];
      group.push(e);
      listGroups.set(e.listId, group);
    } else if (ITEM_TYPES.has(e.type) && e.itemId) {
      const group = itemGroups.get(e.itemId) ?? [];
      group.push(e);
      itemGroups.set(e.itemId, group);
    } else {
      kept.push({ first: e.id, events: [e] });
    }
  }

  const gone = new Set<string>();
  for (const [listId, group] of listGroups) {
    const made = group.some((e) => e.type === "createList");
    const out = collapseList(group);
    if (made && out.length === 0) gone.add(listId);
    kept.push({ first: group[0].id, events: out });
  }
  for (const group of itemGroups.values()) {
    kept.push({ first: group[0].id, events: collapseItem(group) });
  }

  return kept
    .sort((a, b) => a.first - b.first)
    .flatMap((k) => k.events)
    .filter((e) => !gone.has(e.listId));
}
