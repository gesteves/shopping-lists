// Reads of the local view. The hooks in ./hooks.ts use them.
import { copy } from "@/copy";
import { SUMMARY_MIN_ITEMS, summaryKey } from "@/shared/summary";
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
  /**
   * The names of the unchecked items, in list order, when there are fewer
   * than SUMMARY_MIN_ITEMS (thus one name). Else empty.
   */
  names: string[];
  /** True if `summary` tells about the unchecked items now. */
  current: boolean;
  /**
   * True if the server makes a new summary for the unchecked items (#91):
   * the server makes summaries, and the summary is not current.
   */
  pending: boolean;
}

/**
 * The lists that are not deleted, by name, each with its unchecked count
 * and, for a short list, the names. Also the state of the summary.
 */
export async function readListSummaries(db: ClientDb): Promise<ListSummary[]> {
  const [lists, items, summaries] = await Promise.all([
    readLists(db),
    db.items.filter((i) => i.deletedAt === null && !i.checked).toArray(),
    getMeta(db, "summaries"),
  ]);
  const byList = new Map<string, ItemRecord[]>();
  for (const item of items) {
    byList.set(item.listId, [...(byList.get(item.listId) ?? []), item]);
  }
  return lists.map((list) => {
    const unchecked = byList.get(list.id) ?? [];
    const short = unchecked.length < SUMMARY_MIN_ITEMS;
    const current = !short && summaryKey(unchecked) === list.summaryKey;
    return {
      ...list,
      remaining: unchecked.length,
      names: short ? sortItems(unchecked).map((i) => i.name) : [],
      current,
      pending: summaries === true && !short && !current,
    };
  });
}

/**
 * The text under a list name on the lists page: "Nothing to get", the
 * names of a short list, the current summary from Claude, or the count.
 * The page shows sparkles in place of it while a summary is pending.
 */
export function listLine(list: ListSummary): string {
  if (list.remaining === 0) return copy.lists.nothingToGet;
  if (list.remaining < SUMMARY_MIN_ITEMS) return copy.lists.names(list.names);
  if (list.current && list.summary) return list.summary;
  return copy.lists.remaining(list.remaining);
}
