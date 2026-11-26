// The read module. The sync pull (#6) and the MCP tools (#19) read through
// it. Writes go through applyOps (src/server/ops.ts).
import "server-only";
import { asc, eq, gt } from "drizzle-orm";
import { getDb, type Reader } from "@/db/client";
import { items, lists, serverSeq, users } from "@/db/schema";
import type { ItemRecord, ListRecord, UserRecord } from "@/shared/sync";

type ListRow = typeof lists.$inferSelect;
type ItemRow = typeof items.$inferSelect;

const ms = (d: Date | null) => (d ? d.getTime() : null);

export function toListRecord(row: ListRow): ListRecord {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
    updatedVia: row.updatedVia,
    deletedAt: ms(row.deletedAt),
    seq: row.seq,
  };
}

export function toItemRecord(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    listId: row.listId,
    name: row.name,
    quantity: row.quantity,
    notes: row.notes,
    checked: row.checked,
    checkedAt: ms(row.checkedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
    updatedVia: row.updatedVia,
    deletedAt: ms(row.deletedAt),
    seq: row.seq,
  };
}

/** All users, without their emails. */
export function readUsers(db: Reader = getDb()): UserRecord[] {
  return db
    .select({ id: users.id, name: users.name, image: users.image })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
}

/** The last seq, and the largest seq that a purge deleted. */
export function readSeqState(db: Reader = getDb()): {
  seq: number;
  purgedSeq: number;
} {
  const row = db
    .select({ seq: serverSeq.value, purgedSeq: serverSeq.purgedSeq })
    .from(serverSeq)
    .where(eq(serverSeq.id, 1))
    .get();
  return row ?? { seq: 0, purgedSeq: 0 };
}

export interface Changes {
  lists: ListRecord[];
  items: ItemRecord[];
  /** The largest field clock in the rows, or null. */
  hlc: string | null;
  /** The seq of the last row, or null if there are no rows. */
  lastSeq: number | null;
  hasMore: boolean;
}

/**
 * The lists and items with a seq after `since`, tombstones included, in seq
 * order. At most `limit` rows. Lists and items share one seq counter, thus a
 * page ends between two rows and never in one seq.
 */
export function readChanges(
  since: number,
  limit: number,
  db: Reader = getDb(),
): Changes {
  const listRows = db
    .select()
    .from(lists)
    .where(gt(lists.seq, since))
    .orderBy(asc(lists.seq))
    .limit(limit + 1)
    .all();
  const itemRows = db
    .select()
    .from(items)
    .where(gt(items.seq, since))
    .orderBy(asc(items.seq))
    .limit(limit + 1)
    .all();

  const rows = [
    ...listRows.map((row) => ({ kind: "list" as const, row })),
    ...itemRows.map((row) => ({ kind: "item" as const, row })),
  ].sort((a, b) => a.row.seq - b.row.seq);
  const page = rows.slice(0, limit);

  let hlc: string | null = null;
  const out: Changes = {
    lists: [],
    items: [],
    hlc: null,
    lastSeq: page.at(-1)?.row.seq ?? null,
    hasMore: rows.length > limit,
  };
  for (const entry of page) {
    for (const clock of Object.values(entry.row.clocks)) {
      if (clock && (hlc === null || clock > hlc)) hlc = clock;
    }
    if (entry.kind === "list") out.lists.push(toListRecord(entry.row));
    else out.items.push(toItemRecord(entry.row));
  }
  out.hlc = hlc;
  return out;
}
