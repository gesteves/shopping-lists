// The events of the notifier (#16): activity rows, as the notifier reads
// them.
import type { ActivitySnapshot } from "@/db/schema";
import type { OpType, Via } from "@/shared/ops";

export interface ActivityEvent {
  id: number;
  actorId: string;
  via: Via;
  type: OpType;
  listId: string;
  itemId: string | null;
  snapshot: ActivitySnapshot;
  /** Server time in ms. */
  at: number;
}

type SnapshotKey = keyof ActivitySnapshot;

/**
 * The snapshot keys that each event type uses. Collapse and the model input
 * keep only these keys, thus a key of a different event (for example the
 * `fromListName` of a later move on an add) does not go to the text.
 */
export const SNAPSHOT_KEYS: Record<OpType, readonly SnapshotKey[]> = {
  createList: ["listName"],
  renameList: ["listName", "oldName"],
  deleteList: ["listName"],
  restoreList: ["listName"],
  addItem: ["listName", "itemName"],
  updateItem: ["listName", "itemName", "oldName", "fields", "unchecked"],
  check: ["listName", "itemName"],
  uncheck: ["listName", "itemName"],
  deleteItem: ["listName", "itemName"],
  restoreItem: ["listName", "itemName"],
  moveItem: ["listName", "itemName", "fromListName", "unchecked"],
  clearChecked: ["listName", "count"],
  uncheckAll: ["listName", "count"],
  checkAll: ["listName", "count"],
  // The uncheck of a mark is not in the text: "out of stock" tells it.
  markOutOfStock: ["listName", "itemName"],
  markInStock: ["listName", "itemName"],
};

/** The snapshot with only the keys of the type, and no undefined values. */
export function snapshotFor(
  type: OpType,
  snapshot: ActivitySnapshot,
): ActivitySnapshot {
  const out: Partial<ActivitySnapshot> = {};
  for (const key of SNAPSHOT_KEYS[type]) {
    if (snapshot[key] !== undefined)
      (out as Record<SnapshotKey, unknown>)[key] = snapshot[key];
  }
  return { ...out, listName: snapshot.listName };
}
