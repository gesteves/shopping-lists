// Local writes and the view rebuild. Each function runs in one Dexie
// transaction.
import { HlcClock, MAX_DRIFT_MS, parse, serialize } from "@/shared/hlc";
import { opSchema, type Op, type OpInput, type OpType } from "@/shared/ops";
import type { PullResponse } from "@/shared/sync";
import type { EntityTable } from "dexie";
import { getMeta, setMeta, type ClientDb, type MetaValues } from "../db";
import { applyLocal, type LocalState } from "./apply";

/** An op without its envelope: mutate() adds opId, clientId, and hlc. */
export type OpRequest = {
  [T in OpType]: { type: T; args: Extract<OpInput, { type: T }>["args"] };
}[OpType];

/** The client ID of this browser. It makes one if there is none. */
export async function ensureClientId(db: ClientDb): Promise<string> {
  return db.transaction("rw", db.meta, async () => {
    const id = await getMeta(db, "clientId");
    if (id) return id;
    const created = crypto.randomUUID();
    await setMeta(db, "clientId", created);
    return created;
  });
}

/**
 * The clock of this device as the server sees it: the device time plus the
 * stored offset (#115). A device clock that is slow or fast then gives the
 * server time. Read it in a transaction on `meta`.
 */
export async function localNow(db: ClientDb): Promise<() => number> {
  const offset = (await getMeta(db, "clockOffset")) ?? 0;
  return () => Date.now() + offset;
}

/** Keep the offset from the server time of a push or a pull response. */
export async function saveClockOffset(db: ClientDb, serverNow: number) {
  if (!Number.isFinite(serverNow)) return;
  await setMeta(db, "clockOffset", Math.round(serverNow - Date.now()));
}

/**
 * The clock of this browser, from the meta table. Read and write it only in
 * a transaction on `meta`: then two tabs cannot give the same HLC. The
 * default `now` is localNow().
 *
 * If the stored HLC is more than MAX_DRIFT_MS after `now`, it came from a
 * clock that was too far ahead, and the server refuses each op after it.
 * Thus the clock starts again from `now`. The check uses the server time,
 * not the device time: on a slow device, an HLC from a pull is not ahead
 * (#115).
 */
export async function loadClock(
  db: ClientDb,
  now?: () => number,
): Promise<{ clientId: string; clock: HlcClock }> {
  const clientId = await ensureClientId(db);
  const clockNow = now ?? (await localNow(db));
  let last = await getMeta(db, "hlc");
  if (last !== undefined && parse(last).wall - clockNow() > MAX_DRIFT_MS) {
    last = serialize({
      wall: Math.floor(clockNow()),
      counter: 0,
      node: clientId,
    });
  }
  return { clientId, clock: new HlcClock(clientId, last, clockNow) };
}

/**
 * Stamp outbox ops again with a new opId and a new HLC, after the server
 * refused them with `clock_ahead`. The time is `serverNow` if the device
 * clock is after it. Each op keeps its place in the outbox.
 */
export async function restampOps(
  db: ClientDb,
  seqs: number[],
  serverNow: number,
): Promise<void> {
  await db.transaction("rw", [db.meta, db.outbox], async () => {
    const local = await localNow(db);
    const { clock } = await loadClock(db, () => Math.min(local(), serverNow));
    for (const seq of seqs) {
      const entry = await db.outbox.get(seq);
      if (!entry) continue;
      const op = opSchema.parse({
        ...entry.op,
        opId: crypto.randomUUID(),
        hlc: clock.now(),
      });
      await db.outbox.update(seq, { opId: op.opId, op, restamped: true });
    }
    await setMeta(db, "hlc", clock.last);
  });
}

/**
 * Apply an op to the view and add it to the outbox, in one transaction. It
 * throws a ZodError if the op is not valid, and then writes nothing.
 *
 * `forUser` is the user of the page. The entry keeps it: a reset for that
 * user keeps the entry (#115). The default is the stored user.
 */
export async function mutateLocal(
  db: ClientDb,
  request: OpRequest,
  forUser?: string,
): Promise<Op> {
  return db.transaction(
    "rw",
    [db.meta, db.outbox, db.lists, db.items],
    async () => {
      const { clientId, clock } = await loadClock(db);
      const op = opSchema.parse({
        opId: crypto.randomUUID(),
        clientId,
        hlc: clock.now(),
        ...request,
      });
      await setMeta(db, "hlc", clock.last);
      const userId = forUser ?? (await getMeta(db, "userId")) ?? "";
      await db.outbox.add({ opId: op.opId, op, userId });

      const state: LocalState = {
        lists: new Map((await db.lists.toArray()).map((l) => [l.id, l])),
        items: new Map(),
      };
      const rows =
        "itemId" in op.args && op.type !== "addItem"
          ? [await db.items.get(op.args.itemId)]
          : "listId" in op.args
            ? await db.items.where("listId").equals(op.args.listId).toArray()
            : [];
      for (const row of rows) if (row) state.items.set(row.id, row);

      const changed = applyLocal(state, op, userId);
      await db.lists.bulkPut(
        [...changed.lists].map((id) => state.lists.get(id)!),
      );
      await db.items.bulkPut(
        [...changed.items].map((id) => state.items.get(id)!),
      );
      return op;
    },
  );
}

/**
 * Make the view again: the server rows, then each pending op in outbox
 * order. A rejected or merged op is not in the outbox, thus its change goes.
 */
export async function rebuildView(db: ClientDb): Promise<void> {
  await db.transaction(
    "rw",
    [db.serverLists, db.serverItems, db.lists, db.items, db.outbox, db.meta],
    async () => {
      const state: LocalState = {
        lists: new Map((await db.serverLists.toArray()).map((l) => [l.id, l])),
        items: new Map((await db.serverItems.toArray()).map((i) => [i.id, i])),
      };
      const userId = (await getMeta(db, "userId")) ?? "";
      for (const entry of await db.outbox.orderBy("seq").toArray()) {
        applyLocal(state, entry.op, entry.userId || userId);
      }
      // Write only the rows that changed. A full rewrite at each sync makes
      // large transactions that block the writes of the user.
      await writeChanged(db.lists, state.lists);
      await writeChanged(db.items, state.items);
    },
  );
}

/** True if two flat records have the same keys and values. */
function sameRecord(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) if (ra[key] !== rb[key]) return false;
  return true;
}

async function writeChanged<T extends { id: string }>(
  table: EntityTable<T, "id">,
  next: Map<string, T>,
) {
  const current = await table.toArray();
  const gone = current.filter((row) => !next.has(row.id)).map((row) => row.id);
  const before = new Map(current.map((row) => [row.id, row]));
  const changed = [...next.values()].filter((row) => {
    const old = before.get(row.id);
    return !old || !sameRecord(old, row);
  });
  if (gone.length > 0) await table.bulkDelete(gone as never);
  if (changed.length > 0) await table.bulkPut(changed);
}

/**
 * Write one pull page to the server layer. Then call rebuildView().
 *
 * A reset page does not clear the server layer: a failed page 2 then
 * deletes nothing (#115). The `resetting` marker keeps the IDs of the rows
 * that the pages gave. After the last page, the rows with no ID there go.
 */
export async function savePullPage(
  db: ClientDb,
  page: PullResponse,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.serverLists, db.serverItems, db.users, db.meta],
    async () => {
      // An old server sends no `now`.
      if (typeof page.now === "number") await saveClockOffset(db, page.now);
      const marker: MetaValues["resetting"] | undefined = page.reset
        ? { lists: [], items: [] }
        : await getMeta(db, "resetting");
      await db.serverLists.bulkPut(page.lists);
      await db.serverItems.bulkPut(page.items);
      await db.users.bulkPut(page.users);
      if (marker) {
        marker.lists.push(...page.lists.map((l) => l.id));
        marker.items.push(...page.items.map((i) => i.id));
        if (page.hasMore) {
          await setMeta(db, "resetting", marker);
        } else {
          await deleteUnmarked(db.serverLists, marker.lists);
          await deleteUnmarked(db.serverItems, marker.items);
          await db.meta.delete("resetting");
        }
      }
      if (page.hlc) {
        // The next local op must sort after each change that this device
        // saw. The server already limits the drift, thus there is no limit.
        const { clock } = await loadClock(db);
        clock.receive(page.hlc, Number.POSITIVE_INFINITY);
        await setMeta(db, "hlc", clock.last);
      }
      await setMeta(db, "cursor", page.cursor);
      // An old server sends no purgedSeq.
      if (typeof page.purgedSeq === "number") {
        await setMeta(db, "purgedSeq", page.purgedSeq);
      }
    },
  );
}

/** Delete the rows whose ID is not in `keep`. */
async function deleteUnmarked<T extends { id: string }>(
  table: EntityTable<T, "id">,
  keep: string[],
) {
  const marked = new Set(keep);
  const ids = (await table.toCollection().primaryKeys()) as string[];
  const gone = ids.filter((id) => !marked.has(id));
  if (gone.length > 0) await table.bulkDelete(gone as never);
}

/**
 * Delete the lists, items, users, and outbox. Keep the outbox entries of
 * `keepFor`: the ops that the new user made before the user check (#115).
 * Call it in a transaction.
 */
async function clearData(db: ClientDb, keepFor?: string) {
  // Keep meta: the device keeps its client ID, its clock, and its offset.
  for (const table of db.tables) {
    if (table.name !== "meta" && table.name !== "outbox") await table.clear();
  }
  await db.outbox
    .filter((e) => keepFor === undefined || e.userId !== keepFor)
    .delete();
  await db.meta.bulkDelete(["cursor", "purgedSeq", "resetting"]);
}

/**
 * A different user signed in on this browser. Delete the local data, so that
 * the ops of the first user do not go to the server as the second user. The
 * ops that the page of the new user made stay, on an empty view.
 */
export async function resetForUser(db: ClientDb, userId: string) {
  await db.transaction("rw", db.tables, async () => {
    const current = await getMeta(db, "userId");
    if (current === userId) return;
    await setMeta(db, "userId", userId);
    if (current === undefined) return;
    await clearData(db, userId);
    if ((await db.outbox.count()) > 0) await rebuildView(db);
  });
}

/**
 * Sign-out (#103): delete the local data and the user. The device keeps its
 * client ID and its clock.
 */
export async function clearForSignOut(db: ClientDb) {
  await db.transaction("rw", db.tables, async () => {
    await clearData(db);
    await db.meta.delete("userId");
  });
}

/** The ops that the server does not have yet: the entries with no ack. */
export function pendingCount(db: ClientDb): Promise<number> {
  return db.outbox.filter((e) => !e.acked).count();
}
