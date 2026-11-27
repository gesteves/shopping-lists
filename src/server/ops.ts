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
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Db, type Tx } from "@/db/client";
import {
  activity,
  items,
  lists,
  processedOps,
  type ActivitySnapshot,
} from "@/db/schema";
import { HlcError, parse, type HlcClock } from "@/shared/hlc";
import { nameKey } from "@/shared/names";
import type { ItemClocks, ListClocks, Op, OpOf, Via } from "@/shared/ops";
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

/** What one op did. `activity` is set only if a row changed. */
interface Outcome {
  result: StoredResult;
  activity?: {
    listId: string;
    itemId?: string;
    snapshot: ActivitySnapshot;
  };
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
 * Write the summary of a list (src/server/summary/). This is the one write
 * that does not go through applyOps: the summary comes from the items, not
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
    .values({ opId: op.opId, userId: ctx.actor.id, result: outcome.result })
    .run();

  if (outcome.activity) {
    ctx.tx
      .insert(activity)
      .values({
        opId: op.opId,
        actorId: ctx.actor.id,
        via: ctx.via,
        type: op.type,
        listId: outcome.activity.listId,
        itemId: outcome.activity.itemId ?? null,
        snapshot: outcome.activity.snapshot,
        at: ctx.now,
      })
      .run();
  }
  return outcome.result;
}

function dispatch(ctx: Ctx, op: Op): Outcome {
  switch (op.type) {
    case "createList":
      return createList(ctx, op);
    case "renameList":
    case "deleteList":
    case "restoreList":
      return changeList(ctx, op);
    case "addItem":
      return addItem(ctx, op);
    case "updateItem":
    case "check":
    case "uncheck":
    case "deleteItem":
    case "restoreItem":
    case "moveItem":
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

function getItem(ctx: Ctx, id: string): ItemRow | undefined {
  return ctx.tx.select().from(items).where(eq(items.id, id)).get();
}

/** Save the new clocks, and the fields in `set` if there are any. */
/**
 * A new delete gets the server time in `tombstonedAt`, and a restore clears
 * it. The purge uses the server time, not the op time (#101).
 */
function markTombstone(ctx: Ctx, set: ListSet | ItemSet) {
  if (set.deletedAt instanceof Date) set.tombstonedAt = ctx.now;
  else if (set.deletedAt === null) set.tombstonedAt = null;
}

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
      createdBy: ctx.actor.id,
      createdAt: time,
      clocks: { name: op.hlc, deleted: op.hlc },
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
  const row = getList(ctx, op.args.listId);
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

// Items

function addItem(ctx: Ctx, op: OpOf<"addItem">): Outcome {
  const { itemId, listId, name, quantity, notes } = op.args;
  const list = getList(ctx, listId);
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
    return {
      result: { opId: op.opId, status: "merged", into: match.id, changed },
      activity: changed
        ? {
            listId,
            itemId: match.id,
            snapshot: { listName: list.name, itemName: match.name },
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
    checked: op.hlc,
    deleted: op.hlc,
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
      snapshot: { listName: list.name, itemName: name },
    },
  };
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
  >,
): Outcome {
  const row = getItem(ctx, op.args.itemId);
  if (!row) return reject(op, "item_not_found");

  let target: ListRow | undefined;
  if (op.type === "moveItem") {
    target = getList(ctx, op.args.toListId);
    if (!target) return reject(op, "list_not_found");
    if (target.deletedAt) return reject(op, "list_deleted");
  }

  const set: ItemSet = {};
  const clocks: ItemClocks = { ...row.clocks };
  switch (op.type) {
    case "updateItem": {
      const { name, quantity, notes } = op.args.fields;
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
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
    }
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
      markAlive(clocks, row.deletedAt, set, op.hlc);
      break;
  }

  const changed = saveItem(ctx, op, row, set, clocks);
  if (!changed) return { result: applied(op, false) };

  const list = target ?? getList(ctx, row.listId);
  const snapshot: ActivitySnapshot = {
    listName: list?.name ?? "",
    itemName: set.name ?? row.name,
  };
  if (op.type === "moveItem") {
    snapshot.fromListName = getList(ctx, row.listId)?.name ?? "";
  }
  if (set.name !== undefined) snapshot.oldName = row.name;
  if (op.type === "updateItem") {
    const fields = (["name", "quantity", "notes"] as const).filter(
      (field) => set[field] !== undefined,
    );
    if (fields.length > 0) snapshot.fields = fields;
  }
  return {
    result: applied(op, true),
    activity: { listId: list?.id ?? row.listId, itemId: row.id, snapshot },
  };
}

/**
 * clearChecked deletes, and uncheckAll unchecks, each item that is checked
 * with a check older than the op. checkAll (#67) checks each item that is
 * not checked, with an uncheck older than the op. An item that someone
 * checked or unchecked after the op HLC stays: the person did not see that
 * change. An item added after the op stays too, because addItem sets its
 * check clock.
 */
function changeAllItems(
  ctx: Ctx,
  op: OpOf<"clearChecked" | "uncheckAll" | "checkAll">,
): Outcome {
  const list = getList(ctx, op.args.listId);
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

  let count = 0;
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
      markAlive(clocks, row.deletedAt, set, op.hlc);
    }
    if (saveItem(ctx, op, row, set, clocks)) count++;
  }

  if (count === 0) return { result: applied(op, false, 0) };
  return {
    result: applied(op, true, count),
    activity: { listId: list.id, snapshot: { listName: list.name, count } },
  };
}

// Purge
