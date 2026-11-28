// applyOps: the one write path. The app (through sync), the MCP tools, and
// the server use it. See "Sync design" in docs/PLAN.md.
//
// Merge rules:
//   - Each field has its own HLC clock (`clocks`). An op writes a field only
//     if its HLC is newer than the clock of that field. Thus concurrent edits
//     to different fields both stay, and an old offline edit loses to a newer
//     edit.
//   - "deleted" is a field too. A delete writes deleted = true. A restore and
//     each edit write deleted = false. Thus the later of a delete and an edit
//     wins, in each order of arrival.
//   - An op that writes only clocks (no visible change) is "applied" with
//     `changed: false`. It gets no seq, no activity row, and no poke.
//   - Each op is applied one time only (processed_ops). A retry gets
//     "duplicate" and the first result.
import "server-only";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb, type Db, type Tx } from "@/db/client";
import {
  activity,
  items,
  lists,
  processedOps,
  serverSeq,
  type ActivitySnapshot,
} from "@/db/schema";
import { DAY_MS, EXPIRE_AFTER_DAYS } from "@/shared/expiry";
import { HlcError, parse, type HlcClock } from "@/shared/hlc";
import { nameKey } from "@/shared/names";
import type {
  ItemClocks,
  ListClocks,
  Op,
  OpOf,
  OpType,
  Via,
} from "@/shared/ops";
import type { OpResult, RejectReason, StoredResult } from "@/shared/sync";
import { bus } from "./bus";
import { getServerClock } from "./clock";

export type { OpResult, RejectReason, StoredResult };

export interface Actor {
  /** The users.id of the person. An MCP write uses the token owner. */
  id: string;
}

export interface ApplyResult {
  results: OpResult[];
  /** The last seq of this call, or null if no row changed. */
  seq: number | null;
}

export interface ApplyOptions {
  db?: Db;
  clock?: HlcClock;
  /** Server time in ms, for `activity.at`. Tests give a fixed value. */
  now?: () => number;
}

type ListRow = typeof lists.$inferSelect;
type ItemRow = typeof items.$inferSelect;
type ItemSet = Partial<typeof items.$inferInsert>;
type ListSet = Partial<typeof lists.$inferInsert>;

interface Ctx {
  tx: Tx;
  actor: Actor;
  via: Via;
  now: Date;
  lastSeq: number | null;
}

/** One activity row of an op. */
interface ActivityRow {
  /** The type of the activity row, if it is not the op type. */
  type?: OpType;
  listId: string;
  itemId?: string;
  snapshot: ActivitySnapshot;
}

/**
 * What one op did. `activity` is set only if a row changed. A bulk op gives
 * one activity row for each item that it changed (#133).
 */
interface Outcome {
  result: StoredResult;
  activity?: ActivityRow | ActivityRow[];
}

/**
 * Apply ops for one person, in one transaction. Each op gets a result, in the
 * same order. The ops must be valid (`opSchema`).
 *
 * It throws only on an unexpected error. Then nothing is written.
 */
export function applyOps(
  actor: Actor,
  via: Via,
  ops: readonly Op[],
  options: ApplyOptions = {},
): ApplyResult {
  const db = options.db ?? getDb();
  const clock = options.clock ?? getServerClock();
  const now = options.now ?? Date.now;

  const { results, seq } = db.transaction((tx) => {
    const ctx: Ctx = { tx, actor, via, now: new Date(now()), lastSeq: null };
    const results = ops.map((op) => applyOne(ctx, clock, op));
    return { results, seq: ctx.lastSeq };
  });

  if (seq !== null) bus.emit("poke", { seq });
  return { results, seq };
}

/**
 * Make each item row a tombstone, with no actor. Each row gets the server
 * HLC as its delete clock (a newer edit brings it back, an older one does
 * not), `now` (server time) in `deletedAt` and `tombstonedAt`, and a new
 * seq. It writes no processed_ops and no activity rows. It returns the last
 * seq, or null if there are no rows. The caller pokes after the
 * transaction. expireCheckedItems() and the purge use it.
 */
export function tombstoneItems(
  tx: Tx,
  rows: readonly Pick<ItemRow, "id" | "clocks">[],
  clock: HlcClock,
  now: Date,
): number | null {
  let seq: number | null = null;
  for (const row of rows) {
    seq = bumpSeq(tx);
    tx.update(items)
      .set({
        clocks: { ...row.clocks, deleted: clock.now() },
        deletedAt: now,
        tombstonedAt: now,
        seq,
      })
      .where(eq(items.id, row.id))
      .run();
  }
  return seq;
}

/**
 * Delete each checked item whose check is older than EXPIRE_AFTER_DAYS
 * (#112). This is a write-path exception (CLAUDE.md): there is no person to
 * be the actor, thus it writes no processed_ops. It writes one activity
 * row for each item, with `via` "system", no actor, and `notified_at` set,
 * thus the history has it but no push goes (#152). Each row becomes a
 * tombstone (tombstoneItems), thus a newer uncheck or edit brings it back. The normal purge removes the row 30 days
 * later. It returns the number of deleted items.
 */
export function expireCheckedItems(
  options: { db?: Db; clock?: HlcClock; now?: () => number } = {},
): number {
  const db = options.db ?? getDb();
  const clock = options.clock ?? getServerClock();
  const now = new Date((options.now ?? Date.now)());
  const cutoff = new Date(now.getTime() - EXPIRE_AFTER_DAYS * DAY_MS);
  const last = db.transaction((tx) => {
    const rows = tx
      .select({
        id: items.id,
        clocks: items.clocks,
        listId: items.listId,
        name: items.name,
        listName: lists.name,
        listPrivate: lists.private,
        listOwner: lists.createdBy,
      })
      .from(items)
      .innerJoin(lists, eq(lists.id, items.listId))
      .where(
        and(
          eq(items.checked, true),
          isNull(items.deletedAt),
          lt(items.checkedAt, cutoff),
        ),
      )
      .all();
    for (const row of rows) {
      tx.insert(activity)
        .values({
          actorId: null,
          via: "system",
          type: "expireItem",
          listId: row.listId,
          itemId: row.id,
          snapshot: { listName: row.listName, itemName: row.name },
          at: now,
          opAt: now,
          notifiedAt: now,
          privateTo: row.listPrivate ? row.listOwner : null,
        })
        .run();
    }
    return { count: rows.length, seq: tombstoneItems(tx, rows, clock, now) };
  });
  if (last.seq !== null) bus.emit("poke", { seq: last.seq });
  return last.count;
}

/**
 * Write the summary of a list (src/server/summary/). This write does not go
 * through applyOps (CLAUDE.md): the summary comes from the items, not
 * from a person. It gets a seq and a poke, so the clients pull it, but no
 * clocks, no attribution, and no activity row. It writes nothing to a
 * deleted or missing list. It returns true if it wrote the summary.
 */
export function setListSummary(
  listId: string,
  summary: string,
  key: string,
  options: Pick<ApplyOptions, "db"> = {},
): boolean {
  const db = options.db ?? getDb();
  const seq = db.transaction((tx) => {
    const row = tx
      .select({ deletedAt: lists.deletedAt })
      .from(lists)
      .where(eq(lists.id, listId))
      .get();
    if (!row || row.deletedAt) return null;
    const seq = bumpSeq(tx);
    tx.update(lists)
      .set({ summary, summaryKey: key, seq })
      .where(eq(lists.id, listId))
      .run();
    return seq;
  });
  if (seq === null) return false;
  bus.emit("poke", { seq });
  return true;
}

function applyOne(ctx: Ctx, clock: HlcClock, op: Op): OpResult {
  const done = ctx.tx
    .select({ result: processedOps.result, userId: processedOps.userId })
    .from(processedOps)
    .where(eq(processedOps.opId, op.opId))
    .get();
  // The opId belongs to a different user. Refuse it, and keep the first
  // result: a different user must not see or replace it.
  if (done && done.userId !== ctx.actor.id) {
    return { opId: op.opId, status: "rejected", reason: "op_conflict" };
  }
  if (done) {
    return {
      opId: op.opId,
      status: "duplicate",
      original: done.result as StoredResult,
    };
  }

  let outcome: Outcome;
  try {
    clock.receive(op.hlc);
    outcome = dispatch(ctx, op);
  } catch (error) {
    if (!(error instanceof HlcError)) throw error;
    outcome = reject(op, "clock_ahead");
  }

  ctx.tx
    .insert(processedOps)
    .values({
      opId: op.opId,
      userId: ctx.actor.id,
      result: outcome.result,
      processedAt: ctx.now,
    })
    .run();

  // One insert for each row: one insert of many rows can pass the SQLite
  // limit of variables.
  const owners = new Map<string, string | null>();
  for (const row of [outcome.activity ?? []].flat()) {
    if (!owners.has(row.listId)) {
      owners.set(row.listId, privateOwner(ctx.tx, row.listId));
    }
    const privateTo = owners.get(row.listId) ?? null;
    ctx.tx
      .insert(activity)
      .values({
        opId: op.opId,
        actorId: ctx.actor.id,
        via: ctx.via,
        type: row.type ?? op.type,
        listId: row.listId,
        itemId: row.itemId ?? null,
        snapshot: row.snapshot,
        at: ctx.now,
        opAt: opTime(op),
        privateTo,
        // A change on a private list sends no push (#154), also after a
        // later share.
        notifiedAt: privateTo ? ctx.now : null,
      })
      .run();
  }
  return outcome.result;
}

/**
 * The creator of the list if the list is private, else null (#154). The
 * activity rows of the list get it in `private_to`.
 */
export function privateOwner(tx: Tx, listId: string): string | null {
  const row = tx
    .select({ private: lists.private, createdBy: lists.createdBy })
    .from(lists)
    .where(eq(lists.id, listId))
    .get();
  return row?.private ? row.createdBy : null;
}

function dispatch(ctx: Ctx, op: Op): Outcome {
  switch (op.type) {
    case "createList":
      return createList(ctx, op);
    case "renameList":
    case "deleteList":
    case "restoreList":
      return changeList(ctx, op);
    case "setListPrivate":
      return setListPrivate(ctx, op);
    case "addItem":
      return addItem(ctx, op);
    case "updateItem":
    case "check":
    case "uncheck":
    case "deleteItem":
    case "restoreItem":
    case "moveItem":
    case "markOutOfStock":
    case "markInStock":
      return changeItem(ctx, op);
    case "clearChecked":
    case "uncheckAll":
    case "checkAll":
      return changeAllItems(ctx, op);
  }
}

// Helpers

function reject(op: Op, reason: RejectReason): Outcome {
  return { result: { opId: op.opId, status: "rejected", reason } };
}

function applied(op: Op, changed: boolean, count?: number): StoredResult {
  return {
    opId: op.opId,
    status: "applied",
    changed,
    ...(count !== undefined && { count }),
  };
}

/** True if `hlc` is newer than `clock`. A missing clock is the oldest. */
function newer(hlc: string, clock: string | undefined): boolean {
  return clock === undefined || hlc > clock;
}

/** The time of the op: the wall time of its HLC. */
function opTime(op: Op): Date {
  return new Date(parse(op.hlc).wall);
}

function bumpSeq(tx: Tx): number {
  return tx.get<{ value: number }>(
    sql`INSERT INTO server_seq (id, value) VALUES (1, 1)
        ON CONFLICT (id) DO UPDATE SET value = value + 1
        RETURNING value`,
  ).value;
}

function nextSeq(ctx: Ctx): number {
  ctx.lastSeq = bumpSeq(ctx.tx);
  return ctx.lastSeq;
}

/** The fields that a write sets on each changed row. */
function stamp(ctx: Ctx, op: Op, previous: Date) {
  const time = opTime(op);
  return {
    seq: nextSeq(ctx),
    updatedBy: ctx.actor.id,
    updatedVia: ctx.via,
    updatedAt: time > previous ? time : previous,
  };
}

/**
 * Write deleted = false at `hlc`, if `hlc` is newer than the delete clock. A
 * deleted row comes back.
 */
function markAlive(
  clocks: ListClocks | ItemClocks,
  deletedAt: Date | null,
  set: ListSet | ItemSet,
  hlc: string,
) {
  if (!newer(hlc, clocks.deleted)) return;
  clocks.deleted = hlc;
  if (deletedAt) set.deletedAt = null;
}

function getList(ctx: Ctx, id: string): ListRow | undefined {
  return ctx.tx.select().from(lists).where(eq(lists.id, id)).get();
}

/**
 * The list, if the actor can see it (#154): a shared list, or a private
 * list of the actor. A private list of another user is "not found", the
 * same as a list that does not exist.
 */
function getVisibleList(ctx: Ctx, id: string): ListRow | undefined {
  const row = getList(ctx, id);
  return row && canSee(ctx.actor.id, row) ? row : undefined;
}

/** True if the user can see the list (#154). */
export function canSee(
  userId: string,
  list: Pick<ListRow, "private" | "createdBy">,
): boolean {
  return !list.private || list.createdBy === userId;
}

function getItem(ctx: Ctx, id: string): ItemRow | undefined {
  return ctx.tx.select().from(items).where(eq(items.id, id)).get();
}

/**
 * A new delete gets the server time in `tombstonedAt`, and a restore clears
 * it. The purge uses the server time, not the op time (#101).
 */
function markTombstone(ctx: Ctx, set: ListSet | ItemSet) {
  if (set.deletedAt instanceof Date) set.tombstonedAt = ctx.now;
  else if (set.deletedAt === null) set.tombstonedAt = null;
}

/** Save the new clocks, and the fields in `set` if there are any. */
function saveList(
  ctx: Ctx,
  op: Op,
  row: ListRow,
  set: ListSet,
  clocks: ListClocks,
) {
  const changed = Object.keys(set).length > 0;
  markTombstone(ctx, set);
  ctx.tx
    .update(lists)
    .set(
      changed
        ? { ...set, clocks, ...stamp(ctx, op, row.updatedAt) }
        : { clocks },
    )
    .where(eq(lists.id, row.id))
    .run();
  return changed;
}

function saveItem(
  ctx: Ctx,
  op: Op,
  row: ItemRow,
  set: ItemSet,
  clocks: ItemClocks,
) {
  const changed = Object.keys(set).length > 0;
  // Each change of `checked` goes through here (#150).
  if (set.checked !== undefined) {
    set.uncheckedAt = set.checked ? null : opTime(op);
  }
  markTombstone(ctx, set);
  ctx.tx
    .update(items)
    .set(
      changed
        ? { ...set, clocks, ...stamp(ctx, op, row.updatedAt) }
        : { clocks },
    )
    .where(eq(items.id, row.id))
    .run();
  return changed;
}

// Lists

function createList(ctx: Ctx, op: OpOf<"createList">): Outcome {
  const { listId, name } = op.args;
  if (getList(ctx, listId)) return reject(op, "list_exists");

  const time = opTime(op);
  ctx.tx
    .insert(lists)
    .values({
      id: listId,
      name,
      private: op.args.private,
      createdBy: ctx.actor.id,
      createdAt: time,
      clocks: { name: op.hlc, deleted: op.hlc, private: op.hlc },
      ...stamp(ctx, op, time),
    })
    .run();
  return {
    result: applied(op, true),
    activity: { listId, snapshot: { listName: name } },
  };
}

function changeList(
  ctx: Ctx,
  op: OpOf<"renameList" | "deleteList" | "restoreList">,
): Outcome {
  const row = getVisibleList(ctx, op.args.listId);
  if (!row) return reject(op, "list_not_found");

  const set: ListSet = {};
  const clocks: ListClocks = { ...row.clocks };
  switch (op.type) {
    case "renameList":
      if (newer(op.hlc, clocks.name)) {
        clocks.name = op.hlc;
        if (row.name !== op.args.name) set.name = op.args.name;
      }
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    case "deleteList":
      if (newer(op.hlc, clocks.deleted)) {
        clocks.deleted = op.hlc;
        if (!row.deletedAt) set.deletedAt = opTime(op);
      }
      break;
    case "restoreList":
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
  }

  const changed = saveList(ctx, op, row, set, clocks);
  if (!changed) return { result: applied(op, false) };

  const snapshot: ActivitySnapshot = { listName: set.name ?? row.name };
  if (set.name !== undefined) snapshot.oldName = row.name;
  // The items that the delete hides. The items do not change.
  const count =
    op.type === "deleteList"
      ? ctx.tx
          .select({ n: sql<number>`count(*)` })
          .from(items)
          .where(and(eq(items.listId, row.id), isNull(items.deletedAt)))
          .get()!.n
      : undefined;
  return {
    result: applied(op, true, count),
    activity: { listId: row.id, snapshot },
  };
}

/**
 * Make a list private, or share it again (#154). Only the creator can.
 *
 * - Private: the other users must lose the list and its items, also on a
 *   device that has them. Thus `purged_seq` goes to the seq of this write,
 *   and each client resets one time: the reset deletes each row that it
 *   does not get.
 * - Shared: each item gets a new seq, thus the other users pull them.
 *
 * Each activity row of the list gets the new `private_to`: the history
 * follows the privacy now.
 */
function setListPrivate(ctx: Ctx, op: OpOf<"setListPrivate">): Outcome {
  const row = getVisibleList(ctx, op.args.listId);
  if (!row) return reject(op, "list_not_found");
  if (row.createdBy !== ctx.actor.id) return reject(op, "not_owner");

  const set: ListSet = {};
  const clocks: ListClocks = { ...row.clocks };
  if (newer(op.hlc, clocks.private)) {
    clocks.private = op.hlc;
    if (row.private !== op.args.private) set.private = op.args.private;
  }
  const changed = saveList(ctx, op, row, set, clocks);
  if (!changed) return { result: applied(op, false) };

  if (op.args.private) {
    const seq = ctx.lastSeq!;
    ctx.tx
      .update(serverSeq)
      .set({ purgedSeq: sql`max(${serverSeq.purgedSeq}, ${seq})` })
      .where(eq(serverSeq.id, 1))
      .run();
  } else {
    const rows = ctx.tx
      .select({ id: items.id })
      .from(items)
      .where(eq(items.listId, row.id))
      .all();
    for (const item of rows) {
      ctx.tx
        .update(items)
        .set({ seq: nextSeq(ctx) })
        .where(eq(items.id, item.id))
        .run();
    }
  }
  ctx.tx
    .update(activity)
    .set({ privateTo: op.args.private ? row.createdBy : null })
    .where(eq(activity.listId, row.id))
    .run();

  return {
    result: applied(op, true),
    activity: {
      listId: row.id,
      snapshot: { listName: row.name, private: op.args.private },
    },
  };
}

// Items

function addItem(ctx: Ctx, op: OpOf<"addItem">): Outcome {
  const { itemId, listId, name, quantity, notes, url } = op.args;
  const list = getVisibleList(ctx, listId);
  if (!list) return reject(op, "list_not_found");
  if (list.deletedAt) return reject(op, "list_deleted");
  if (getItem(ctx, itemId)) return reject(op, "item_exists");

  const key = nameKey(name);
  const match = ctx.tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.listId, listId),
        eq(items.nameKey, key),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(items.createdAt, items.id)
    .get();

  if (match) {
    // The name is on the list. Do not add a second row. Uncheck the item if
    // it is checked: the person wants to buy it again.
    const set: ItemSet = {};
    const clocks: ItemClocks = { ...match.clocks };
    if (newer(op.hlc, clocks.checked)) {
      clocks.checked = op.hlc;
      if (match.checked) {
        set.checked = false;
        set.checkedAt = null;
      }
    }
    markAlive(clocks, match.deletedAt, set, op.hlc);
    const changed = saveItem(ctx, op, match, set, clocks);
    // The add only unchecked the item. Collapse counts it as an uncheck
    // (#133).
    return {
      result: { opId: op.opId, status: "merged", into: match.id, changed },
      activity: changed
        ? {
            listId,
            itemId: match.id,
            snapshot: {
              listName: list.name,
              itemName: match.name,
              unchecked: true,
            },
          }
        : undefined,
    };
  }

  const time = opTime(op);
  const clocks: ItemClocks = {
    listId: op.hlc,
    name: op.hlc,
    quantity: op.hlc,
    notes: op.hlc,
    url: op.hlc,
    checked: op.hlc,
    deleted: op.hlc,
    outOfStock: op.hlc,
  };
  ctx.tx
    .insert(items)
    .values({
      id: itemId,
      listId,
      name,
      nameKey: key,
      quantity,
      notes,
      url,
      checked: false,
      createdBy: ctx.actor.id,
      createdAt: time,
      clocks,
      ...stamp(ctx, op, time),
    })
    .run();
  return {
    result: applied(op, true),
    activity: {
      listId,
      itemId,
      // The values let collapse find a delete and an add of the same item
      // (#133).
      snapshot: { listName: list.name, itemName: name, quantity, notes, url },
    },
  };
}

/**
 * An edit or a move of a checked item also unchecks it (#112): the person
 * is going to buy it again. Only when the op changed the item, and only if
 * the op is newer than the check clock.
 */
function uncheckOnChange(
  row: ItemRow,
  set: ItemSet,
  clocks: ItemClocks,
  op: Op,
) {
  if (!row.checked || !newer(op.hlc, clocks.checked)) return;
  clocks.checked = op.hlc;
  set.checked = false;
  set.checkedAt = null;
}

/**
 * Write "in stock" at the op HLC, if the HLC is newer than the stock clock
 * (#131). A check and a check all always do this, thus the result is the
 * same in each order of arrival. A move does it only when it changed the
 * list, the same as uncheckOnChange.
 */
function restock(row: ItemRow, set: ItemSet, clocks: ItemClocks, op: Op) {
  if (!newer(op.hlc, clocks.outOfStock)) return;
  clocks.outOfStock = op.hlc;
  if (row.outOfStockAt) set.outOfStockAt = null;
}

function changeItem(
  ctx: Ctx,
  op: OpOf<
    | "updateItem"
    | "check"
    | "uncheck"
    | "deleteItem"
    | "restoreItem"
    | "moveItem"
    | "markOutOfStock"
    | "markInStock"
  >,
): Outcome {
  const row = getItem(ctx, op.args.itemId);
  // An item on a list that the actor cannot see is "not found" (#154).
  const source = row && getVisibleList(ctx, row.listId);
  if (!row || !source) return reject(op, "item_not_found");

  let target: ListRow | undefined;
  if (op.type === "moveItem") {
    target = getVisibleList(ctx, op.args.toListId);
    if (!target) return reject(op, "list_not_found");
    if (target.deletedAt) return reject(op, "list_deleted");
    // A move never takes an item across the privacy line (#154): copy it.
    if (target.private !== source.private) {
      return reject(op, "privacy_mismatch");
    }
  }

  const set: ItemSet = {};
  const clocks: ItemClocks = { ...row.clocks };
  switch (op.type) {
    case "updateItem": {
      const { name, quantity, notes, url } = op.args.fields;
      if (name !== undefined && newer(op.hlc, clocks.name)) {
        clocks.name = op.hlc;
        if (row.name !== name) {
          set.name = name;
          set.nameKey = nameKey(name);
        }
      }
      if (quantity !== undefined && newer(op.hlc, clocks.quantity)) {
        clocks.quantity = op.hlc;
        if (row.quantity !== quantity) set.quantity = quantity;
      }
      if (notes !== undefined && newer(op.hlc, clocks.notes)) {
        clocks.notes = op.hlc;
        if (row.notes !== notes) set.notes = notes;
      }
      if (url !== undefined && newer(op.hlc, clocks.url)) {
        clocks.url = op.hlc;
        if (row.url !== url) set.url = url;
      }
      if (Object.keys(set).length > 0) uncheckOnChange(row, set, clocks, op);
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    }
    case "check":
    case "uncheck": {
      const checked = op.type === "check";
      if (newer(op.hlc, clocks.checked)) {
        clocks.checked = op.hlc;
        if (row.checked !== checked) {
          set.checked = checked;
          set.checkedAt = checked ? opTime(op) : null;
        }
      }
      // An item in the cart is in stock (#131).
      if (checked) restock(row, set, clocks, op);
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    }
    case "markOutOfStock":
      if (newer(op.hlc, clocks.outOfStock)) {
        clocks.outOfStock = op.hlc;
        if (!row.outOfStockAt) set.outOfStockAt = opTime(op);
      }
      // The person did not get it: it is not in the cart. Always write the
      // check clock, as a check writes the stock clock. Thus the result is
      // the same in each order of arrival.
      if (newer(op.hlc, clocks.checked)) {
        clocks.checked = op.hlc;
        if (row.checked) {
          set.checked = false;
          set.checkedAt = null;
        }
      }
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    case "markInStock":
      restock(row, set, clocks, op);
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    case "deleteItem":
      if (newer(op.hlc, clocks.deleted)) {
        clocks.deleted = op.hlc;
        if (!row.deletedAt) set.deletedAt = opTime(op);
      }
      break;
    case "restoreItem":
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    case "moveItem":
      if (newer(op.hlc, clocks.listId)) {
        clocks.listId = op.hlc;
        if (row.listId !== op.args.toListId) set.listId = op.args.toListId;
      }
      // The item was out of stock at the other store, not at this one.
      if (set.listId !== undefined) {
        uncheckOnChange(row, set, clocks, op);
        restock(row, set, clocks, op);
      }
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
  }

  const changed = saveItem(ctx, op, row, set, clocks);
  if (!changed) return { result: applied(op, false) };

  // A move that did not change the list (it lost on its clock, or the item
  // is on that list) changed only the deleted state: it is a restore, on
  // the list where the item is (#118).
  if (op.type === "moveItem" && set.listId === undefined) {
    const list = getList(ctx, row.listId);
    return {
      result: applied(op, true),
      activity: {
        type: "restoreItem",
        listId: row.listId,
        itemId: row.id,
        snapshot: { listName: list?.name ?? "", itemName: row.name },
      },
    };
  }

  const list = target ?? getList(ctx, row.listId);
  const snapshot: ActivitySnapshot = {
    listName: list?.name ?? "",
    itemName: set.name ?? row.name,
  };
  if (op.type === "moveItem") {
    snapshot.fromListName = getList(ctx, row.listId)?.name ?? "";
    snapshot.fromListId = row.listId;
  }
  if (set.name !== undefined) snapshot.oldName = row.name;
  if (set.checked === false && op.type !== "uncheck") snapshot.unchecked = true;
  if (set.outOfStockAt === null && op.type !== "markInStock") {
    snapshot.inStock = true;
  }
  if (op.type === "updateItem") {
    const fields = (["name", "quantity", "notes", "url"] as const).filter(
      (field) => set[field] !== undefined,
    );
    if (fields.length > 0) snapshot.fields = fields;
    // The values before and after, for collapse: an edit back to the first
    // value is no change (#133).
    if (set.quantity !== undefined) {
      snapshot.oldQuantity = row.quantity;
      snapshot.quantity = set.quantity;
    }
    if (set.notes !== undefined) {
      snapshot.oldNotes = row.notes;
      snapshot.notes = set.notes;
    }
    if (set.url !== undefined) {
      snapshot.oldUrl = row.url;
      snapshot.url = set.url;
    }
  }
  // The item before the delete. Collapse compares it with a new add of the
  // same name (#133).
  if (op.type === "deleteItem") {
    snapshot.quantity = row.quantity;
    snapshot.notes = row.notes;
    snapshot.url = row.url;
    if (row.checked) snapshot.checked = true;
    if (row.outOfStockAt) snapshot.outOfStock = true;
  }
  return {
    result: applied(op, true),
    activity: { listId: list?.id ?? row.listId, itemId: row.id, snapshot },
  };
}

/**
 * clearChecked deletes, and uncheckAll unchecks, each item that is checked
 * with a check older than the op. checkAll (#67) checks each item that is
 * not checked, with an uncheck older than the op, and marks it in stock
 * (#131). An item that someone checked or unchecked after the op HLC stays:
 * the person did not see that change. An item added after the op stays
 * too, because addItem sets its check clock.
 */
function changeAllItems(
  ctx: Ctx,
  op: OpOf<"clearChecked" | "uncheckAll" | "checkAll">,
): Outcome {
  const list = getVisibleList(ctx, op.args.listId);
  if (!list) return reject(op, "list_not_found");
  if (list.deletedAt) return reject(op, "list_deleted");

  const rows = ctx.tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.listId, list.id),
        eq(items.checked, op.type !== "checkAll"),
        isNull(items.deletedAt),
      ),
    )
    .orderBy(items.id)
    .all();

  // One activity row for each item, thus collapse can cancel the changes
  // of one item, for example the undo of this op (#133).
  const changed: ActivityRow[] = [];
  for (const row of rows) {
    if (!newer(op.hlc, row.clocks.checked)) continue;
    const set: ItemSet = {};
    const clocks: ItemClocks = { ...row.clocks };
    if (op.type === "clearChecked") {
      // A later edit of the item (a newer delete clock) keeps it.
      if (!newer(op.hlc, clocks.deleted)) continue;
      clocks.deleted = op.hlc;
      set.deletedAt = opTime(op);
    } else {
      const checked = op.type === "checkAll";
      clocks.checked = op.hlc;
      set.checked = checked;
      set.checkedAt = checked ? opTime(op) : null;
      if (checked) restock(row, set, clocks, op);
      markAlive(clocks, row.deletedAt, set, op.hlc);
    }
    if (!saveItem(ctx, op, row, set, clocks)) continue;
    const snapshot: ActivitySnapshot = {
      listName: list.name,
      itemName: row.name,
    };
    if (set.outOfStockAt === null) snapshot.inStock = true;
    changed.push({ listId: list.id, itemId: row.id, snapshot });
  }

  if (changed.length === 0) return { result: applied(op, false, 0) };
  return { result: applied(op, true, changed.length), activity: changed };
}
