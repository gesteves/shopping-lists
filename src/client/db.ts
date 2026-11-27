// The local database (IndexedDB, through Dexie). See "Sync design" in
// docs/PLAN.md.
//
// There are two layers:
//   - serverLists and serverItems: the rows as the last pull gave them.
//   - lists and items: the view. It is the server rows with the pending
//     outbox ops applied on top. The UI reads only the view.
// After each sync, rebuildView() makes the view again from the two layers.
// Thus a rejected op goes away, and a merged row is dropped.
import { Dexie, type EntityTable } from "dexie";
import type { Op } from "@/shared/ops";
import type { ItemRecord, ListRecord, UserRecord } from "@/shared/sync";

export interface OutboxEntry {
  /** The order of the ops. Dexie sets it. */
  seq?: number;
  opId: string;
  op: Op;
  /** True after the engine stamped the op again for `clock_ahead`. */
  restamped?: boolean;
}

/** Values in the meta table. */
export interface MetaValues {
  /** The node of the HLC clock and the clientId of each op. */
  clientId: string;
  /** The last HLC of this device. It keeps the clock monotonic. */
  hlc: string;
  /** The `since` of the next pull. */
  cursor: number;
  /** The `purgedSeq` of the last pull. The next pull sends it as `seen`. */
  purgedSeq: number;
  /** The signed-in user. Local ops use it for createdBy and updatedBy. */
  userId: string;
}

export interface MetaEntry<K extends keyof MetaValues = keyof MetaValues> {
  key: K;
  value: MetaValues[K];
}

export class ClientDb extends Dexie {
  lists!: EntityTable<ListRecord, "id">;
  items!: EntityTable<ItemRecord, "id">;
  serverLists!: EntityTable<ListRecord, "id">;
  serverItems!: EntityTable<ItemRecord, "id">;
  users!: EntityTable<UserRecord, "id">;
  outbox!: EntityTable<OutboxEntry, "seq">;
  meta!: EntityTable<MetaEntry, "key">;

  constructor(name = "shopping-lists") {
    super(name);
    // Only the indexed fields are here. Change the version for a new index.
    this.version(1).stores({
      lists: "id",
      items: "id, listId",
      serverLists: "id",
      serverItems: "id",
      users: "id",
      outbox: "++seq, &opId",
      meta: "key",
    });
  }
}

let db: ClientDb | undefined;

/** The database of this browser. Call it only in the browser. */
export function getClientDb(): ClientDb {
  db ??= new ClientDb();
  return db;
}

export async function getMeta<K extends keyof MetaValues>(
  db: ClientDb,
  key: K,
): Promise<MetaValues[K] | undefined> {
  const entry = await db.meta.get(key);
  return entry?.value as MetaValues[K] | undefined;
}

export function setMeta<K extends keyof MetaValues>(
  db: ClientDb,
  key: K,
  value: MetaValues[K],
) {
  return db.meta.put({ key, value } as MetaEntry);
}
