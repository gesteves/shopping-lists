// The read module. The sync pull (#6) and the MCP tools (#19) read through
// it. Writes go through applyOps (src/server/ops.ts).
import "server-only";
import { and, asc, desc, eq, gt, isNull, like, ne, or, sql } from "drizzle-orm";
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
    summary: row.summary,
    summaryKey: row.summaryKey,
    private: row.private,
    seq: row.seq,
  };
}

/**
 * The SQL condition for the lists that the user can see (#154): the shared
 * lists, and the private lists of the user.
 */
export function visibleTo(userId: string) {
  return or(eq(lists.private, false), eq(lists.createdBy, userId));
}

/**
 * The IDs of the private lists of other users (#154), tombstones included.
 * Presence leaves them out.
 */
export function readHiddenListIds(
  userId: string,
  db: Reader = getDb(),
): Set<string> {
  return new Set(
    db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.private, true), ne(lists.createdBy, userId)))
      .all()
      .map((r) => r.id),
  );
}

export function toItemRecord(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    listId: row.listId,
    name: row.name,
    quantity: row.quantity,
    notes: row.notes,
    url: row.url,
    checked: row.checked,
    checkedAt: ms(row.checkedAt),
    outOfStockAt: ms(row.outOfStockAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.getTime(),
    updatedVia: row.updatedVia,
    deletedAt: ms(row.deletedAt),
    seq: row.seq,
  };
}

/**
 * An item for the MCP tools: the sync record and the time of the last
 * uncheck (#150). The clients do not get `uncheckedAt`.
 */
export type ServerItemRecord = ItemRecord & { uncheckedAt: number | null };

function toServerItemRecord(row: ItemRow): ServerItemRecord {
  return { ...toItemRecord(row), uncheckedAt: ms(row.uncheckedAt) };
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
 * The lists and items with a seq after `since` that the user can see,
 * tombstones included, in seq order. At most `limit` rows. Lists and items
 * share one seq counter, thus a page ends between two rows and never in one
 * seq.
 *
 * The SQL filters the private lists of other users and their items (#154).
 * A filter after `limit` can give an empty page with `hasMore`.
 */
export function readChanges(
  since: number,
  limit: number,
  userId: string,
  db: Reader = getDb(),
): Changes {
  const listRows = db
    .select()
    .from(lists)
    .where(and(gt(lists.seq, since), visibleTo(userId)))
    .orderBy(asc(lists.seq))
    .limit(limit + 1)
    .all();
  const itemRows = db
    .select({ item: items })
    .from(items)
    .innerJoin(lists, eq(lists.id, items.listId))
    .where(and(gt(items.seq, since), visibleTo(userId)))
    .orderBy(asc(items.seq))
    .limit(limit + 1)
    .all()
    .map((r) => r.item);

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

// Reads for the MCP tools (#19). They return live rows only: no tombstones.
// The order is the order of the app (src/client/queries.ts).

/**
 * The lists that are not deleted and that the user can see, by name, with
 * their item counts.
 */
export function readLiveLists(userId: string, db: Reader = getDb()) {
  const rows = db
    .select({
      list: lists,
      itemCount: sql<number>`count(${items.id})`,
      uncheckedCount: sql<number>`coalesce(sum(case when ${items.checked} = 0 then 1 else 0 end), 0)`,
    })
    .from(lists)
    .leftJoin(items, and(eq(items.listId, lists.id), isNull(items.deletedAt)))
    .where(and(isNull(lists.deletedAt), visibleTo(userId)))
    .groupBy(lists.id)
    .orderBy(sql`${lists.name} collate nocase`, asc(lists.createdAt))
    .all();
  return rows.map((r) => ({
    list: toListRecord(r.list),
    itemCount: Number(r.itemCount),
    uncheckedCount: Number(r.uncheckedCount),
  }));
}

/**
 * A list by ID that the user can see, tombstone included, or undefined. A
 * private list of another user is undefined (#154).
 */
export function readListById(id: string, userId: string, db: Reader = getDb()) {
  const row = db
    .select()
    .from(lists)
    .where(and(eq(lists.id, id), visibleTo(userId)))
    .get();
  return row && toListRecord(row);
}

/** The live items of a list: unchecked first, then the last updated first. */
export function readListItems(listId: string, db: Reader = getDb()) {
  return db
    .select()
    .from(items)
    .where(and(eq(items.listId, listId), isNull(items.deletedAt)))
    .orderBy(asc(items.checked), desc(items.updatedAt), asc(items.name))
    .all()
    .map(toServerItemRecord);
}

/**
 * The live items on live lists that the user can see, whose name contains
 * `key` (a nameKey of the query), with their list. At most `limit` rows.
 */
export function searchLiveItems(
  key: string,
  limit: number,
  userId: string,
  db: Reader = getDb(),
) {
  const pattern = `%${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select({ item: items, listName: lists.name })
    .from(items)
    .innerJoin(lists, eq(lists.id, items.listId))
    .where(
      and(
        isNull(items.deletedAt),
        isNull(lists.deletedAt),
        visibleTo(userId),
        like(items.nameKey, sql`${pattern} escape '\\'`),
      ),
    )
    .orderBy(
      asc(items.checked),
      sql`${lists.name} collate nocase`,
      asc(items.nameKey),
    )
    .limit(limit)
    .all()
    .map((r) => ({ item: toServerItemRecord(r.item), listName: r.listName }));
}
