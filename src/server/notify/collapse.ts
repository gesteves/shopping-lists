// Remove the changes that cancel out, before a notification (#16). See
// "Notifications" in docs/PLAN.md. Input: the events of one person, in
// order. Output: the events that are left, in the order of their first
// event.
//
// Rules, for each item and each list:
//   - Check, then uncheck (or the other way) → nothing. An edit or a move
//     that also unchecked the item (#112) counts as an uncheck too; the edit
//     or the move stays. A mark out of stock that unchecked (#131), and an
//     add of a name that was checked on the list (#133), count as an
//     uncheck too.
//   - Out of stock, then in stock (or the other way) → nothing. A check or a
//     move that marked the item in stock counts as "in stock"; the check or
//     the move stays (#131).
//   - If the event of an uncheck or an "in stock" cancels out, but the
//     change stays, it gives "unchecked" or "marked in stock" (#133). For
//     example: a check of an item that was out of stock, then an uncheck.
//   - Add, then delete → nothing. Delete, then undo (restore) → nothing.
//   - An item or a list that is not there at the start and at the end (new
//     or deleted before, and deleted at the end) → nothing, also for the
//     items of such a list.
//   - Add, then update or move → only "added" (with the last names).
//   - More than one update → one update, with only the fields that end at
//     a different value. Updates that end at the first values → nothing
//     (#133). More than one move → one move from the first list to the
//     last list; a move back → nothing.
//   - Delete an item, then add a new item with the same name, quantity,
//     notes, and URL to the same list → nothing (#133). The deleted item must not be
//     checked or out of stock, and its other changes in the burst must
//     cancel out. The new item must end unchecked and in stock.
//   - Create, then rename → "created" with the new name. Renames that end at
//     the first name → nothing.
// A bulk op (delete checked, uncheck all, check all) writes one row for
// each item (#133). Each row counts as a delete, an uncheck, or a check of
// its item. The rows that are left after the rules above give one bulk
// event for each op type and list, with their count. Older bulk rows (one
// row, no item) stay as they are. Each event keeps only the snapshot keys
// of its type (SNAPSHOT_KEYS).
import type { OpType } from "@/shared/ops";
import { snapshotFor, type ActivityEvent } from "./types";

type BulkType = "clearChecked" | "uncheckAll" | "checkAll";

/** The item change of one item row of a bulk op. */
const BULK_ROLE: Record<BulkType, OpType> = {
  clearChecked: "deleteItem",
  uncheckAll: "uncheck",
  checkAll: "check",
};

/** An event in collapse. `bulk` is set for an item row of a bulk op. */
type Event = ActivityEvent & { bulk?: BulkType };

const ITEM_TYPES = new Set<OpType>([
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
const LIST_TYPES = new Set<OpType>([
  "createList",
  "renameList",
  "deleteList",
  "restoreList",
]);

/** The events that tell a change of the checked state. */
const TELLS_CHECK = new Set<OpType>(["check", "uncheck", "addItem"]);
/** The events that tell a change of the stock state. */
const TELLS_STOCK = new Set<OpType>(["markOutOfStock", "markInStock"]);

/** An item row of a bulk op becomes the item change that it is. */
function asItemEvent(e: ActivityEvent): Event {
  if (!e.itemId || !(e.type in BULK_ROLE)) return e;
  const bulk = e.type as BulkType;
  return { ...e, type: BULK_ROLE[bulk], bulk };
}

/** A new item. An add of a name that was on the list only unchecks. */
function isNewAdd(e: Event): boolean {
  return e.type === "addItem" && e.snapshot.unchecked !== true;
}

/**
 * True for an uncheck, also an edit, a move, a mark, or an add that
 * unchecked (#112, #131, #133).
 */
function unchecks(e: Event): boolean {
  return e.type === "uncheck" || e.snapshot.unchecked === true;
}

/** The check and uncheck events, with the edits that unchecked. */
function checkEvents(events: Event[]): Event[] {
  return events.filter((e) => e.type === "check" || unchecks(e));
}

/** True for a mark in stock, also a check or a move that did it (#131). */
function restocks(e: Event): boolean {
  return e.type === "markInStock" || e.snapshot.inStock === true;
}

/** The out of stock and in stock events, with the checks and moves. */
function stockEvents(events: Event[]): Event[] {
  return events.filter((e) => e.type === "markOutOfStock" || restocks(e));
}

/** The event, with the list and the names of the last event. */
function relabel(event: Event, last: Event): Event {
  return {
    ...event,
    listId: last.listId,
    snapshot: { ...event.snapshot, ...last.snapshot },
  };
}

/**
 * The event, with the names of the last event of its group. A bulk row
 * keeps its list: it counts toward the bulk op on that list.
 */
function withLastNames(event: Event, last: Event): Event {
  return event.bulk ? event : relabel(event, last);
}

/** A change whose event is gone, as an event of `type`. */
function asType(event: Event, type: OpType, last: Event): Event {
  return { ...relabel(event, last), type, bulk: undefined };
}

interface Presence {
  /** The thing was not there before the burst: new, or deleted. */
  goneAtStart: boolean;
  /** The thing is deleted at the end of the burst. */
  goneAtEnd: boolean;
  /** The last delete or restore. */
  lastFlip?: Event;
}

/** If the item or the list was there at the start and at the end. */
function presence(
  events: Event[],
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

/** The last check event, if the item does not end as it started. */
function checkChange(events: Event[]): Event | undefined {
  const checks = checkEvents(events);
  const final = checks.at(-1);
  if (!final) return undefined;
  return unchecks(checks[0]) !== (final.type === "check") ? final : undefined;
}

/** The last stock event, if the item does not end as it started. */
function stockChange(events: Event[]): Event | undefined {
  const stock = stockEvents(events);
  const final = stock.at(-1);
  if (!final) return undefined;
  return restocks(stock[0]) !== (final.type === "markOutOfStock")
    ? final
    : undefined;
}

const VALUE_KEYS = [
  ["quantity", "oldQuantity"],
  ["notes", "oldNotes"],
  ["url", "oldUrl"],
] as const;

/**
 * One update for all the updates, with only the fields that end at a
 * different value. Nothing if all the fields end at their first value. An
 * older row has no values (or no fields): its fields count as changed.
 */
function netUpdate(events: Event[], last: Event): Event | undefined {
  const updates = events.filter((e) => e.type === "updateItem");
  if (updates.length === 0) return undefined;

  const fields = new Set(updates.flatMap((e) => e.snapshot.fields ?? []));
  const oldName = updates.find((e) => e.snapshot.oldName !== undefined)
    ?.snapshot.oldName;
  const renamed = oldName !== undefined && oldName !== last.snapshot.itemName;
  if (!renamed) fields.delete("name");
  for (const [field, oldKey] of VALUE_KEYS) {
    const changes = updates.filter((e) => e.snapshot.fields?.includes(field));
    const from = changes[0]?.snapshot[oldKey];
    if (from !== undefined && from === changes.at(-1)!.snapshot[field])
      fields.delete(field);
  }
  const known = updates.every((e) => e.snapshot.fields !== undefined);
  if (known && fields.size === 0) return undefined;

  const lastUpdate = updates.at(-1)!;
  return {
    ...withLastNames(lastUpdate, last),
    snapshot: {
      ...lastUpdate.snapshot,
      listName: last.snapshot.listName,
      oldName: renamed ? oldName : undefined,
      fields: fields.size > 0 ? [...fields] : undefined,
    },
  };
}

function collapseItem(events: Event[]): Event[] {
  const last = events.at(-1)!;
  const add = events.find(isNewAdd);
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

  const out: Event[] = [];
  /** The IDs of the events that `out` tells. */
  const told = new Set<number>();
  const keep = (event: Event, from: Event[]) => {
    out.push(event);
    for (const e of from) told.add(e.id);
  };

  const update = netUpdate(events, last);
  if (update) {
    keep(
      update,
      events.filter((e) => e.type === "updateItem"),
    );
  }

  const moves = events.filter((e) => e.type === "moveItem");
  if (moves.length > 0) {
    const from = moves[0].snapshot.fromListName;
    const lastMove = moves.at(-1)!;
    if (from !== lastMove.snapshot.listName) {
      keep(
        { ...lastMove, snapshot: { ...lastMove.snapshot, fromListName: from } },
        moves,
      );
    }
  }

  const check = checkChange(events);
  const stock = stockChange(events);
  if (check && TELLS_CHECK.has(check.type))
    keep(withLastNames(check, last), [check]);
  if (stock && TELLS_STOCK.has(stock.type))
    keep(withLastNames(stock, last), [stock]);
  // An edit or a move that unchecked tells the uncheck. If it is gone (for
  // example an edit back), say the uncheck. The same for "in stock".
  if (check && !told.has(check.id)) out.push(asType(check, "uncheck", last));
  if (stock && !told.has(stock.id))
    out.push(asType(stock, "markInStock", last));

  // Deleted before the burst, and there at the end: a restore.
  if (state.goneAtStart) out.push(withLastNames(state.lastFlip!, last));
  return out;
}

interface ItemResult {
  events: Event[];
  out: Event[];
}

/** The values of a new item at the end of the burst, if the rows tell them. */
function addedValues(events: Event[]) {
  const add = events.find(isNewAdd)!;
  let { quantity, notes, url } = add.snapshot;
  for (const e of events) {
    if (e.type !== "updateItem") continue;
    if (!e.snapshot.fields) return undefined;
    if (e.snapshot.fields.includes("quantity")) quantity = e.snapshot.quantity;
    if (e.snapshot.fields.includes("notes")) notes = e.snapshot.notes;
    if (e.snapshot.fields.includes("url")) url = e.snapshot.url;
  }
  return { quantity, notes, url };
}

const PRESENCE_TYPES = new Set<OpType>([
  "addItem",
  "deleteItem",
  "restoreItem",
]);

/**
 * True if the item is deleted at the end, and its other changes in the
 * burst cancel out. Then the delete has the values of the start.
 */
function onlyDeleted(events: Event[]): boolean {
  const del = events.at(-1)!;
  const before = events.slice(0, -1);
  return (
    del.type === "deleteItem" &&
    !del.bulk &&
    del.snapshot.quantity !== undefined &&
    del.snapshot.notes !== undefined &&
    !del.snapshot.checked &&
    !del.snapshot.outOfStock &&
    !before.some((e) => PRESENCE_TYPES.has(e.type)) &&
    (before.length === 0 || collapseItem(before).length === 0)
  );
}

/**
 * Delete an item, then add the same item again → nothing (#133). The
 * deleted item had no other change that is left, and was not checked and
 * not out of stock. The new item ends with the same name, quantity, notes,
 * and URL, on the same list, unchecked and in stock. A row from before
 * #140 has no URL: it counts as no link.
 */
function cancelAddsAgain(results: ItemResult[]) {
  const deletes = results.filter(({ events }) => onlyDeleted(events));
  for (const added of results) {
    const [event] = added.out;
    if (added.out.length !== 1 || !isNewAdd(event)) continue;
    const values = addedValues(added.events);
    if (values?.quantity === undefined || values.notes === undefined) continue;
    const match = deletes.findIndex(({ events }) => {
      const e = events.at(-1)!;
      return (
        e.listId === event.listId &&
        e.snapshot.itemName === event.snapshot.itemName &&
        e.snapshot.quantity === values.quantity &&
        e.snapshot.notes === values.notes &&
        (e.snapshot.url ?? "") === (values.url ?? "")
      );
    });
    if (match === -1) continue;
    deletes[match].out = [];
    deletes.splice(match, 1);
    added.out = [];
  }
}

/**
 * The item rows of bulk ops that are left give one bulk event for each op
 * type and list, at the place of its first row, with their count.
 */
function mergeBulk(events: Event[]): ActivityEvent[] {
  const merged = new Map<string, ActivityEvent>();
  const out: ActivityEvent[] = [];
  for (const { bulk, ...event } of events) {
    if (!bulk) {
      out.push(event);
      continue;
    }
    const key = `${bulk}:${event.listId}`;
    const first = merged.get(key);
    if (first) {
      first.snapshot = {
        listName: event.snapshot.listName,
        count: (first.snapshot.count ?? 0) + 1,
      };
      continue;
    }
    const next: ActivityEvent = {
      ...event,
      type: bulk,
      itemId: null,
      snapshot: { listName: event.snapshot.listName, count: 1 },
    };
    merged.set(key, next);
    out.push(next);
  }
  return out;
}

export function collapse(input: ActivityEvent[]): ActivityEvent[] {
  const listGroups = new Map<string, Event[]>();
  const itemGroups = new Map<string, Event[]>();
  const kept: { first: number; events: Event[] }[] = [];

  for (const e of input.map(asItemEvent)) {
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
  const results = [...itemGroups.values()].map((events) => ({
    events,
    out: collapseItem(events),
  }));
  cancelAddsAgain(results);
  for (const { events, out } of results) {
    kept.push({ first: events[0].id, events: out });
  }

  const events = kept
    .sort((a, b) => a.first - b.first)
    .flatMap((k) => k.events)
    .filter((e) => !gone.has(e.listId));
  return mergeBulk(events).map((e) => ({
    ...e,
    snapshot: snapshotFor(e.type, e.snapshot),
  }));
}

/**
 * The events that are left for a list. `hidden` is true if the list was not
 * there at the start and at the end of the burst: then the changes of its
 * items do not matter.
 */
function collapseList(events: Event[]): {
  events: Event[];
  hidden: boolean;
} {
  const last = events.at(-1)!;
  const create = events.find((e) => e.type === "createList");
  const state = presence(events, "deleteList", "restoreList", !!create);

  if (state.goneAtStart && state.goneAtEnd) return { events: [], hidden: true };
  if (state.goneAtEnd)
    return { events: [withLastNames(state.lastFlip!, last)], hidden: false };
  if (create) return { events: [withLastNames(create, last)], hidden: false };

  const out: Event[] = [];
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
