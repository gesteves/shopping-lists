// Reads of the local view. The hooks in ./hooks.ts use them.
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
}

/** The lists that are not deleted, by name, each with its unchecked count. */
export async function readListSummaries(db: ClientDb): Promise<ListSummary[]> {
  const [lists, items] = await Promise.all([
    readLists(db),
    db.items.filter((i) => i.deletedAt === null && !i.checked).toArray(),
  ]);
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.listId, (counts.get(item.listId) ?? 0) + 1);
  }
  return lists.map((list) => ({
    ...list,
    remaining: counts.get(list.id) ?? 0,
  }));
}
