// Reads of the local view. The hooks in ./hooks.ts use them.
import { copy } from "@/copy";
import { expiresAt, isOlder } from "@/shared/expiry";
import { SUMMARY_MIN_ITEMS } from "@/shared/summary";
import type { ItemRecord, ListRecord } from "@/shared/sync";
import type { ClientDb } from "./db";

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
  /**
   * The names of the unchecked items, in list order, when there are fewer
   * than SUMMARY_MIN_ITEMS (thus one name). Else empty.
   */
  names: string[];
}

/**
 * The lists that are not deleted, by name, each with its unchecked count
 * and, for a short list, the names.
 */
export async function readListSummaries(db: ClientDb): Promise<ListSummary[]> {
  const [lists, items] = await Promise.all([
    readLists(db),
    db.items.filter((i) => i.deletedAt === null && !i.checked).toArray(),
  ]);
  const byList = new Map<string, ItemRecord[]>();
  for (const item of items) {
    byList.set(item.listId, [...(byList.get(item.listId) ?? []), item]);
  }
  return lists.map((list) => {
    const unchecked = byList.get(list.id) ?? [];
    return {
      ...list,
      remaining: unchecked.length,
      names:
        unchecked.length < SUMMARY_MIN_ITEMS
          ? sortItems(unchecked).map((i) => i.name)
          : [],
    };
  });
}

/**
 * The line under a list name on the lists page: "Nothing to get", the
 * names of a short list, the summary from Claude, or the count.
 */
export function listLine(list: ListSummary): string {
  if (list.remaining === 0) return copy.lists.nothingToGet;
  if (list.remaining < SUMMARY_MIN_ITEMS) return copy.lists.names(list.names);
  return list.summary ?? copy.lists.remaining(list.remaining);
}
