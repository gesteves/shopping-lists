// Remove the changes that cancel out, before a notification (#16). See
// "Notifications" in docs/PLAN.md. Input: the events of one person, in
// order. Output: the events that are left, in the order of their first
// event.
//
// Rules, for each item and each list:
//   - Check, then uncheck (or the other way) → nothing. An edit or a move
//     that also unchecked the item (#112) counts as an uncheck too; the edit
//     or the move stays. A mark out of stock that unchecked (#131) counts
//     as an uncheck too.
//   - Out of stock, then in stock (or the other way) → nothing. A check or a
//     move that marked the item in stock counts as "in stock"; the check or
//     the move stays (#131).
//   - Add, then delete → nothing. Delete, then undo (restore) → nothing.
//   - An item or a list that is not there at the start and at the end (new
//     or deleted before, and deleted at the end) → nothing, also for the
//     items of such a list.
//   - Add, then update or move → only "added" (with the last names).
//   - More than one update → one update. More than one move → one move from
//     the first list to the last list; a move back → nothing.
//   - Create, then rename → "created" with the new name. Renames that end at
//     the first name → nothing.
// Bulk events (delete checked, uncheck all, check all) stay. Each event keeps
// only the snapshot keys of its type (SNAPSHOT_KEYS).
import { snapshotFor, type ActivityEvent } from "./types";

const ITEM_TYPES = new Set([
  "addItem",
  "updateItem",
  "check",
  "uncheck",
  "deleteItem",
  "restoreItem",
  "moveItem",
  "markOutOfStock",
  "markInStock",
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

/** True for a mark in stock, also a check or a move that did it (#131). */
function restocks(e: ActivityEvent): boolean {
  return e.type === "markInStock" || e.snapshot.inStock === true;
}

/** The out of stock and in stock events, with the checks and moves. */
function stockEvents(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.type === "markOutOfStock" || restocks(e));
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

interface Presence {
  /** The thing was not there before the burst: new, or deleted. */
  goneAtStart: boolean;
  /** The thing is deleted at the end of the burst. */
  goneAtEnd: boolean;
  /** The last delete or restore. */
  lastFlip?: ActivityEvent;
}

/** If the item or the list was there at the start and at the end. */
function presence(
  events: ActivityEvent[],
  deleteType: "deleteItem" | "deleteList",
  restoreType: "restoreItem" | "restoreList",
  made: boolean,
): Presence {
  const flips = events.filter(
    (e) => e.type === deleteType || e.type === restoreType,
  );
  return {
    goneAtStart: made || flips[0]?.type === restoreType,
    goneAtEnd: flips.at(-1)?.type === deleteType,
    lastFlip: flips.at(-1),
  };
}

function collapseItem(events: ActivityEvent[]): ActivityEvent[] {
  const last = events.at(-1)!;
  const add = events.find((e) => e.type === "addItem");
  const state = presence(events, "deleteItem", "restoreItem", !!add);

  // Not there at the start and not there at the end: nothing to say.
  if (state.goneAtStart && state.goneAtEnd) return [];
  // A removed item: the other changes do not matter.
  if (state.goneAtEnd) return [withLastNames(state.lastFlip!, last)];

  if (add) {
    const out = [withLastNames(add, last)];
    // A new item starts unchecked. Say "checked" only if it ends checked.
    const checks = checkEvents(events);
    if (checks.at(-1)?.type === "check")
      out.push(withLastNames(checks.at(-1)!, last));
    // A new item starts in stock.
    const stock = stockEvents(events);
    if (stock.at(-1)?.type === "markOutOfStock")
      out.push(withLastNames(stock.at(-1)!, last));
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

  const stock = stockEvents(events);
  if (stock.length > 0) {
    const startedOut = restocks(stock[0]);
    const final = stock.at(-1)!;
    const endsOut = final.type === "markOutOfStock";
    // A check or a move that marked it in stock is in `out` already.
    if (
      startedOut !== endsOut &&
      (final.type === "markOutOfStock" || final.type === "markInStock")
    )
      out.push(withLastNames(final, last));
  }

  // Deleted before the burst, and there at the end: a restore.
  if (state.goneAtStart) out.push(withLastNames(state.lastFlip!, last));
  return out;
}

/**
 * The events that are left for a list. `hidden` is true if the list was not
 * there at the start and at the end of the burst: then the changes of its
 * items do not matter.
 */
function collapseList(events: ActivityEvent[]): {
  events: ActivityEvent[];
  hidden: boolean;
} {
  const last = events.at(-1)!;
  const create = events.find((e) => e.type === "createList");
  const state = presence(events, "deleteList", "restoreList", !!create);

  if (state.goneAtStart && state.goneAtEnd) return { events: [], hidden: true };
  if (state.goneAtEnd)
    return { events: [withLastNames(state.lastFlip!, last)], hidden: false };
  if (create) return { events: [withLastNames(create, last)], hidden: false };

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
  if (state.goneAtStart) out.push(withLastNames(state.lastFlip!, last));
  return { events: out, hidden: false };
}

export function collapse(events: ActivityEvent[]): ActivityEvent[] {
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

  // Lists that are not there at the start and at the end: drop everything
  // on them.
  const gone = new Set<string>();
  for (const [listId, group] of listGroups) {
    const out = collapseList(group);
    if (out.hidden) gone.add(listId);
    kept.push({ first: group[0].id, events: out.events });
  }
  for (const group of itemGroups.values()) {
    kept.push({ first: group[0].id, events: collapseItem(group) });
  }

  return kept
    .sort((a, b) => a.first - b.first)
    .flatMap((k) => k.events)
    .filter((e) => !gone.has(e.listId))
    .map((e) => ({ ...e, snapshot: snapshotFor(e.type, e.snapshot) }));
}
