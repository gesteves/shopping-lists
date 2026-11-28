// Copy an item to another list (#131). A copy is an add with the same
// name, quantity, notes, and URL (#140). It obeys the dedupe rules of the add bar (#14,
// #120): a name that is on the target list already gives no second item.
// The app and the MCP tool copy_items (#162) use it.
import { checkedFields } from "./duplicate";
import { nameKey } from "./names";
import type { OpRequest } from "./ops";
import type { ItemRecord } from "./sync";

export type CopyPlan =
  /** A new item on the target list. Its ID is for the undo. */
  | { kind: "add"; itemId: string; requests: OpRequest[] }
  /** The target has the name, checked: uncheck it, with the new fields. */
  | { kind: "uncheck"; itemId: string; requests: OpRequest[] }
  /** The target has the name, unchecked: nothing to do. */
  | { kind: "onList"; itemId: string; requests: [] };

/**
 * The ops for a copy of `item` to `toListId`. `targetItems` are the items of
 * the target list. The match is the oldest live item with the same name, as
 * on the server.
 */
export function copyPlan(
  item: Pick<ItemRecord, "name" | "quantity" | "notes" | "url">,
  toListId: string,
  targetItems: readonly ItemRecord[],
  newId: string = crypto.randomUUID(),
): CopyPlan {
  const key = nameKey(item.name);
  const match = targetItems
    .filter(
      (i) =>
        i.listId === toListId &&
        i.deletedAt === null &&
        nameKey(i.name) === key,
    )
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];

  if (!match) {
    return {
      kind: "add",
      itemId: newId,
      requests: [
        {
          type: "addItem",
          args: {
            itemId: newId,
            listId: toListId,
            name: item.name,
            quantity: item.quantity,
            notes: item.notes,
            // A row from an older server has no url.
            url: item.url ?? "",
          },
        },
      ],
    };
  }
  if (!match.checked) return { kind: "onList", itemId: match.id, requests: [] };

  const fields = checkedFields(match, item);
  return {
    kind: "uncheck",
    itemId: match.id,
    requests: [
      { type: "uncheck", args: { itemId: match.id } },
      ...(fields
        ? [{ type: "updateItem", args: { itemId: match.id, fields } } as const]
        : []),
    ],
  };
}
