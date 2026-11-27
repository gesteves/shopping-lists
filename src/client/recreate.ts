// "Re-create the list" (#104): an add or a move to a list that someone
// deleted while this device was offline. See "Conflict rules" in
// docs/PLAN.md.
import type { Op } from "@/shared/ops";
import { getClientDb } from "./db";
import { mutate } from "./sync";

export interface Recreate {
  /** The deleted list. */
  listId: string;
  listName: string;
  itemName: string;
  kind: "add" | "move";
  /** Make a new list with the same name, and add or move the item to it. */
  run: () => Promise<string>;
}

/**
 * The re-create action for a refused op, or null. A new list, not a
 * restore: a restore brings back each item that the other person deleted
 * with the list.
 */
export async function recreateFor(op: Op): Promise<Recreate | null> {
  if (op.type !== "addItem" && op.type !== "moveItem") return null;
  const db = getClientDb();
  const listId = op.type === "addItem" ? op.args.listId : op.args.toListId;
  const list =
    (await db.serverLists.get(listId)) ?? (await db.lists.get(listId));
  if (!list) return null;
  const itemName =
    op.type === "addItem"
      ? op.args.name
      : ((await db.items.get(op.args.itemId))?.name ??
        (await db.serverItems.get(op.args.itemId))?.name);
  if (itemName === undefined) return null;

  return {
    listId,
    listName: list.name,
    itemName,
    kind: op.type === "addItem" ? "add" : "move",
    run: async () => {
      const newListId = crypto.randomUUID();
      await mutate({
        type: "createList",
        args: { listId: newListId, name: list.name },
      });
      if (op.type === "addItem") {
        await mutate({
          type: "addItem",
          args: { ...op.args, itemId: crypto.randomUUID(), listId: newListId },
        });
      } else {
        await mutate({
          type: "moveItem",
          args: { itemId: op.args.itemId, toListId: newListId },
        });
      }
      return newListId;
    },
  };
}
