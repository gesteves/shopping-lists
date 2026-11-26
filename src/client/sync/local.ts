// Local writes and the view rebuild. Each function runs in one Dexie
// transaction.
import { HlcClock } from "@/shared/hlc";
import { opSchema, type Op, type OpInput, type OpType } from "@/shared/ops";
import type { PullResponse } from "@/shared/sync";
import { getMeta, setMeta, type ClientDb } from "../db";
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
 * The clock of this browser, from the meta table. Read and write it only in
 * a transaction on `meta`: then two tabs cannot give the same HLC.
 */
async function loadClock(
  db: ClientDb,
): Promise<{ clientId: string; clock: HlcClock }> {
  const clientId = await ensureClientId(db);
  return { clientId, clock: new HlcClock(clientId, await getMeta(db, "hlc")) };
}

/**
 * Apply an op to the view and add it to the outbox, in one transaction. It
 * throws a ZodError if the op is not valid, and then writes nothing.
 */
export async function mutateLocal(
  db: ClientDb,
  request: OpRequest,
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
      await db.outbox.add({ opId: op.opId, op });

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

      const userId = (await getMeta(db, "userId")) ?? "";
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
        applyLocal(state, entry.op, userId);
      }
      await db.lists.clear();
      await db.items.clear();
      await db.lists.bulkPut([...state.lists.values()]);
      await db.items.bulkPut([...state.items.values()]);
    },
  );
}

/** Write one pull page to the server layer. Then call rebuildView(). */
export async function savePullPage(
  db: ClientDb,
  page: PullResponse,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.serverLists, db.serverItems, db.users, db.meta],
    async () => {
      if (page.reset) {
        await db.serverLists.clear();
        await db.serverItems.clear();
      }
      await db.serverLists.bulkPut(page.lists);
      await db.serverItems.bulkPut(page.items);
      await db.users.bulkPut(page.users);
      if (page.hlc) {
        // The next local op must sort after each change that this device
        // saw. The server already limits the drift, thus there is no limit.
        const { clock } = await loadClock(db);
        clock.receive(page.hlc, Number.POSITIVE_INFINITY);
        await setMeta(db, "hlc", clock.last);
      }
      await setMeta(db, "cursor", page.cursor);
    },
  );
}

/**
 * A different user signed in on this browser. Delete the local data, so that
 * the ops of the first user do not go to the server as the second user.
 */
export async function resetForUser(db: ClientDb, userId: string) {
  await db.transaction("rw", db.tables, async () => {
    const current = await getMeta(db, "userId");
    if (current === userId) return;
    if (current !== undefined) {
      // Keep meta: the device keeps its client ID and its clock.
      for (const table of db.tables) {
        if (table.name !== "meta") await table.clear();
      }
      await db.meta.delete("cursor");
    }
    await setMeta(db, "userId", userId);
  });
}
