// The daily purge of old tombstones (#20). See "Sync design" in
// docs/PLAN.md: a client with an older cursor gets all rows again.
//
// This is a write-path exception (CLAUDE.md): it deletes rows directly, not
// through applyOps.
import "server-only";
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { activity, items, lists, processedOps } from "@/db/schema";

/** Delete tombstones and old bookkeeping rows after this many days. */
export const PURGE_AFTER_DAYS = 30;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The first purge after boot. Not at once: the boot must stay fast. */
export const FIRST_PURGE_MS = 5 * 60 * 1000;

export interface PurgeResult {
  lists: number;
  items: number;
  processedOps: number;
  activity: number;
  /** The new value of server_seq.purged_seq. */
  purgedSeq: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete the rows of lists and items that the server marked as deleted more
 * than `olderThanDays` ago (`tombstoned_at`, server time). The items of a
 * purged list go too. Also delete old processed_ops rows and old sent
 * activity rows. startPurger() runs it on a schedule.
 *
 * `deleted_at` is the op time (the client clock), thus a delete that came
 * late would go at once. The server time keeps it for the full time (#101).
 *
 * It sets server_seq.purged_seq to the largest seq that it deleted. A pull
 * with an older cursor can miss a delete, thus #6 must send all rows again.
 */
export function purgeTombstones(
  olderThanDays: number,
  options: { db?: Db; now?: () => number } = {},
): PurgeResult {
  const db = options.db ?? getDb();
  const cutoff = new Date((options.now ?? Date.now)() - olderThanDays * DAY_MS);

  return db.transaction((tx) => {
    const oldList = and(
      isNotNull(lists.deletedAt),
      lt(lists.tombstonedAt, cutoff),
    );
    const purgedListIds = tx
      .select({ id: lists.id })
      .from(lists)
      .where(oldList);
    const oldItem = or(
      and(isNotNull(items.deletedAt), lt(items.tombstonedAt, cutoff)),
      inArray(items.listId, purgedListIds),
    );

    const maxOf = (rows: { seq: number | null } | undefined) => rows?.seq ?? 0;
    const maxSeq = Math.max(
      maxOf(
        tx
          .select({ seq: sql<number | null>`max(${items.seq})` })
          .from(items)
          .where(oldItem)
          .get(),
      ),
      maxOf(
        tx
          .select({ seq: sql<number | null>`max(${lists.seq})` })
          .from(lists)
          .where(oldList)
          .get(),
      ),
    );

    const itemCount = tx.delete(items).where(oldItem).run().changes;
    const listCount = tx.delete(lists).where(oldList).run().changes;
    const opCount = tx
      .delete(processedOps)
      .where(lt(processedOps.processedAt, cutoff))
      .run().changes;
    const activityCount = tx
      .delete(activity)
      .where(and(isNotNull(activity.notifiedAt), lt(activity.at, cutoff)))
      .run().changes;

    const row = tx.get<{ purged_seq: number }>(
      sql`INSERT INTO server_seq (id, value, purged_seq) VALUES (1, 0, ${maxSeq})
          ON CONFLICT (id) DO UPDATE SET purged_seq = max(purged_seq, excluded.purged_seq)
          RETURNING purged_seq`,
    );

    return {
      lists: listCount,
      items: itemCount,
      processedOps: opCount,
      activity: activityCount,
      purgedSeq: row.purged_seq,
    };
  });
}

/** Runs one purge. Logs the result, and never throws. */
export function runPurge(
  purge: (days: number) => PurgeResult = purgeTombstones,
): PurgeResult | null {
  try {
    const result = purge(PURGE_AFTER_DAYS);
    console.log("Purged tombstones:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Purge failed:", error);
    return null;
  }
}

/** Starts the schedule one time for the process. */
export function startPurger(purge?: (days: number) => PurgeResult): void {
  const KEY = Symbol.for("shopping-lists.purger");
  const store = globalThis as typeof globalThis & { [KEY]?: true };
  if (store[KEY]) return;
  store[KEY] = true;
  setTimeout(() => {
    runPurge(purge);
    setInterval(() => runPurge(purge), PURGE_EVERY_MS).unref();
  }, FIRST_PURGE_MS).unref();
}
