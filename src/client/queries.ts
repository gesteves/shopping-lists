// Reads of the local view. The hooks in ./hooks.ts use them.
import { copy } from "@/copy";
import { expiresAt, isOlder } from "@/shared/expiry";
import {
  SUMMARY_MIN_ITEMS,
  SUMMARY_WAIT_MS,
  summaryKeyOf,
} from "@/shared/summary";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import { getMeta, type ClientDb } from "./db";

/** The lists that are not deleted, by name. */
export async function readLists(db: ClientDb): Promise<ListRecord[]> {
  const lists = await db.lists.filter((l) => l.deletedAt === null).toArray();
  return lists.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.createdAt - b.createdAt,
  );
}

/** Unchecked items first, then the last updated first. */
export function sortItems(items: ItemRecord[]): ItemRecord[] {
  return [...items].sort(
    (a, b) =>
      Number(a.checked) - Number(b.checked) ||
      b.updatedAt - a.updatedAt ||
      a.name.localeCompare(b.name),
  );
}

/**
 * The items of a list page in two parts (#112): the main list (in the order
 * of `items`), and the checked items that the server deletes in the next
 * OLDER_DAYS. The older items go with the delete that comes soonest last.
 * Without `now` (before mount), all items are in the main list.
 */
export function splitOlder(
  items: ItemRecord[],
  now: number | null,
): { current: ItemRecord[]; older: ItemRecord[] } {
  if (now === null) return { current: items, older: [] };
  const current: ItemRecord[] = [];
  const older: ItemRecord[] = [];
  for (const item of items) {
    const old = item.checked && item.checkedAt !== null;
    if (old && isOlder(item.checkedAt!, now)) older.push(item);
    else current.push(item);
  }
  older.sort(
    (a, b) =>
      expiresAt(b.checkedAt!) - expiresAt(a.checkedAt!) ||
      a.name.localeCompare(b.name),
  );
  return { current, older };
}

export interface ListView {
  list: ListRecord;
  items: ItemRecord[];
}

/** A list and its items that are not deleted, or null. */
export async function readList(
  db: ClientDb,
  id: string,
): Promise<ListView | null> {
  const list = await db.lists.get(id);
  if (!list || list.deletedAt !== null) return null;
  const items = await db.items
    .where("listId")
    .equals(id)
    .filter((i) => i.deletedAt === null)
    .toArray();
  return { list, items: sortItems(items) };
}

export interface ListSummary extends ListRecord {
  /** Items that are not checked and not deleted. */
  remaining: number;
  /** Items that are not deleted, checked or not. */
  total: number;
  /**
   * The names of the unchecked items, in list order, when there are fewer
   * than SUMMARY_MIN_ITEMS (thus one name). Else empty.
   */
  names: string[];
  /** True if `summary` tells about the unchecked items now (#143). */
  summaryFresh: boolean;
  /** True if the server makes summaries. */
  summaries: boolean;
  /**
   * The last change of an item of the list (also a check or a delete), in
   * the time of this device, or 0.
   */
  changedAt: number;
}

/**
 * The lists that are not deleted, by name, each with its unchecked count,
 * its item count, for a short list the names, and if its summary is for
 * the items now.
 */
export async function readListSummaries(db: ClientDb): Promise<ListSummary[]> {
  const [lists, items, summaries, clockOffset] = await Promise.all([
    readLists(db),
    db.items.toArray(),
    getMeta(db, "summaries"),
    getMeta(db, "clockOffset"),
  ]);
  const byList = new Map<string, ItemRecord[]>();
  for (const item of items) {
    byList.set(item.listId, [...(byList.get(item.listId) ?? []), item]);
  }
  return Promise.all(
    lists.map(async (list) => {
      const rows = byList.get(list.id) ?? [];
      const all = rows.filter((i) => i.deletedAt === null);
      const unchecked = all.filter((i) => !i.checked);
      const changedAt = Math.max(
        0,
        ...rows.map((i) => Math.max(i.updatedAt, i.deletedAt ?? 0)),
      );
      // A row from an older server has no summaryKey.
      const summaryFresh =
        list.summary !== null &&
        unchecked.length >= SUMMARY_MIN_ITEMS &&
        list.summaryKey != null &&
        list.summaryKey === (await summaryKeyOf(unchecked));
      return {
        ...list,
        remaining: unchecked.length,
        total: all.length,
        names:
          unchecked.length < SUMMARY_MIN_ITEMS
            ? sortItems(unchecked).map((i) => i.name)
            : [],
        summaryFresh,
        summaries: summaries === true,
        // The op times are in the server time: `clockOffset` ahead.
        changedAt: changedAt === 0 ? 0 : changedAt - (clockOffset ?? 0),
      };
    }),
  );
}

/**
 * The line under a list name on the lists page: "Nothing to get", the
 * names of a short list, the summary from Claude, or the count. Null while
 * a summary for the items now can still come (#143): the page shows a
 * skeleton. A summary for other items never shows: after SUMMARY_WAIT_MS,
 * or if the server makes no summaries, the line is the count. `now` is the
 * time of this device (useNow), or null before mount.
 */
export function listLine(list: ListSummary, now: number | null): string | null {
  if (list.remaining === 0) return copy.lists.nothingToGet;
  if (list.remaining < SUMMARY_MIN_ITEMS) return copy.lists.names(list.names);
  if (list.summaryFresh && list.summary) return list.summary;
  if (
    list.summaries &&
    (now === null || now - list.changedAt < SUMMARY_WAIT_MS)
  )
    return null;
  return copy.lists.remaining(list.remaining);
}

/** The names of the users other than the signed-in user, by name. */
export async function readOtherUserNames(db: ClientDb): Promise<string[]> {
  const [me, users] = await Promise.all([
    getMeta(db, "userId"),
    db.users.toArray(),
  ]);
  return users
    .filter((u) => u.id !== me)
    .map((u) => u.name)
    .sort((a, b) => a.localeCompare(b));
}
