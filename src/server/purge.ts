// The daily purge of old tombstones (#20). See "Sync design" in
// docs/PLAN.md: a client with an older cursor gets all rows again.
//
// This is a write-path exception (CLAUDE.md): it deletes rows directly, not
// through applyOps. It also makes the live items of an old deleted list
// tombstones, with no actor.
import "server-only";
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { activity, items, lists, processedOps } from "@/db/schema";
import type { HlcClock } from "@/shared/hlc";
import { DAY_MS } from "@/shared/expiry";
import { bus } from "./bus";
import { getServerClock } from "./clock";
import { expireCheckedItems, tombstoneItems } from "./ops";

/** Delete tombstones and old sent activity rows after this many days. */
export const PURGE_AFTER_DAYS = 30;
/**
 * Keep processed_ops rows this many days (#119). A retry of an op that the
 * server applied gets "duplicate" for this time. The client keeps an op in
 * its outbox until the server answers, also for a long time offline. After
 * the purge of its row, a retry is applied again: an old addItem can make
 * an item again that someone deleted. The rows are small.
 */
export const KEEP_OPS_DAYS = 180;
export const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The first purge after boot. Not at once: the boot must stay fast. */
export const FIRST_PURGE_MS = 5 * 60 * 1000;

export interface PurgeResult {
  lists: number;
  items: number;
  processedOps: number;
  activity: number;
  /** The live items of old deleted lists that became tombstones. */
  tombstoned: number;
  /** The new value of server_seq.purged_seq. */
  purgedSeq: number;
}

/**
 * Delete the rows of lists and items that the server marked as deleted more
 * than `olderThanDays` ago (`tombstoned_at`, server time). Also delete
 * processed_ops rows older than `keepOpsDays`, and old sent activity rows.
 * startPurger() runs it on a schedule.
 *
 * `deleted_at` is the op time (the client clock), thus a delete that came
 * late would go at once. The server time keeps it for the full time (#101).
 *
 * The items of a deleted list can change (PLAN, conflict rules), thus they
 * can have a recent seq. An old deleted list goes only when each of its
 * items is an old tombstone too (#119). Its live items become tombstones
 * (tombstoneItems, a new seq, a poke), and a later run deletes them and the
 * list. Thus purged_seq never goes to a recent seq, and the clients do not
 * reset for each purge.
 *
 * It sets server_seq.purged_seq to the largest seq that it deleted. A pull
 * with an older cursor can miss a delete, thus #6 must send all rows again.
 */
export function purgeTombstones(
  olderThanDays: number,
  options: {
    db?: Db;
    clock?: HlcClock;
    now?: () => number;
    keepOpsDays?: number;
  } = {},
): PurgeResult {
  const db = options.db ?? getDb();
  const clock = options.clock ?? getServerClock();
  const now = new Date((options.now ?? Date.now)());
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  const opsCutoff = new Date(
    now.getTime() - (options.keepOpsDays ?? KEEP_OPS_DAYS) * DAY_MS,
  );

  const result = db.transaction((tx) => {
    const oldList = and(
      isNotNull(lists.deletedAt),
      lt(lists.tombstonedAt, cutoff),
    );
    const oldItem = and(
      isNotNull(items.deletedAt),
      lt(items.tombstonedAt, cutoff),
    );

    // The live items of old deleted lists become tombstones.
    const live = tx
      .select({ id: items.id, clocks: items.clocks })
      .from(items)
      .where(
        and(
          isNull(items.deletedAt),
          inArray(
            items.listId,
            tx.select({ id: lists.id }).from(lists).where(oldList),
          ),
        ),
      )
      .all();
    const seq = tombstoneItems(tx, live, clock, now);

    // A list goes only with no item that is not an old tombstone. The
    // foreign key deletes the items of a deleted list.
    const keep = or(
      isNull(items.deletedAt),
      isNull(items.tombstonedAt),
      gte(items.tombstonedAt, cutoff),
    );
    const purgedList = and(
      oldList,
      not(
        exists(
          tx
            .select({ one: sql`1` })
            .from(items)
            .where(and(eq(items.listId, lists.id), keep)),
        ),
      ),
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
          .where(purgedList)
          .get(),
      ),
    );

    const itemCount = tx.delete(items).where(oldItem).run().changes;
    const listCount = tx.delete(lists).where(purgedList).run().changes;
    const opCount = tx
      .delete(processedOps)
      .where(lt(processedOps.processedAt, opsCutoff))
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
      seq,
      result: {
        lists: listCount,
        items: itemCount,
        processedOps: opCount,
        activity: activityCount,
        tombstoned: live.length,
        purgedSeq: row.purged_seq,
      },
    };
  });
  if (result.seq !== null) bus.emit("poke", { seq: result.seq });
  return result.result;
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

/** The expiry of old checked items runs this often (#112). */
export const EXPIRE_EVERY_MS = 60 * 60 * 1000;

/** Runs one expiry of old checked items. Logs the count, and never throws. */
export function runExpiry(
  expire: () => number = expireCheckedItems,
): number | null {
  try {
    const count = expire();
    console.log("Expired checked items:", count);
    return count;
  } catch (error) {
    console.error("Expiry failed:", error);
    return null;
  }
}

/**
 * Starts the schedule one time for the process: the purge each day, and the
 * expiry of checked items each hour. Both start FIRST_PURGE_MS after boot.
 */
export function startPurger(
  purge?: (days: number) => PurgeResult,
  expire?: () => number,
): void {
  const KEY = Symbol.for("shopping-lists.purger");
  const store = globalThis as typeof globalThis & { [KEY]?: true };
  if (store[KEY]) return;
  store[KEY] = true;
  setTimeout(() => {
    runPurge(purge);
    runExpiry(expire);
    setInterval(() => runPurge(purge), PURGE_EVERY_MS).unref();
    setInterval(() => runExpiry(expire), EXPIRE_EVERY_MS).unref();
  }, FIRST_PURGE_MS).unref();
}
