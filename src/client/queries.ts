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
