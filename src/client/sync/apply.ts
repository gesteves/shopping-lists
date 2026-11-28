// Apply an op to the local view, as the server will apply it (applyOps in
// src/server/ops.ts), but without the clocks. The local result can be wrong
// for a short time, for example when an edit from a different device is
// newer. The next pull and rebuildView() then correct it.
import { parse } from "@/shared/hlc";
import { nameKey } from "@/shared/names";
import type { Op } from "@/shared/ops";
import type { ItemRecord, ListRecord } from "@/shared/sync";

export interface LocalState {
  lists: Map<string, ListRecord>;
  items: Map<string, ItemRecord>;
}

/** The IDs of the rows that an op changed. */
export interface Changed {
  lists: Set<string>;
  items: Set<string>;
}

export function emptyChanged(): Changed {
  return { lists: new Set(), items: new Set() };
}

/** The fields that a write sets, not a change of the row. */
const STAMP_FIELDS = new Set(["updatedAt", "updatedBy", "updatedVia"]);

/** True if the two rows differ in a field that is not a stamp field. */
function differs(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (!STAMP_FIELDS.has(key) && ra[key] !== rb[key]) return true;
  }
  return false;
}

/**
 * The fields that mark an item in stock (#131). Empty if it is in stock: a
 * row from an older server has no `outOfStockAt`, and must not change.
 */
function inStock(item: ItemRecord): Partial<ItemRecord> {
  return item.outOfStockAt != null ? { outOfStockAt: null } : {};
}

/** Apply `op` to `state`, and add the IDs of the changed rows to `changed`. */
export function applyLocal(
  state: LocalState,
  op: Op,
  userId: string,
  changed: Changed = emptyChanged(),
): Changed {
  const time = parse(op.hlc).wall;
  const stamp = <T extends ListRecord | ItemRecord>(row: T): T => ({
    ...row,
    updatedBy: userId,
    updatedVia: "app",
    updatedAt: Math.max(row.updatedAt, time),
  });
  // As on the server, an op that changes no field does not stamp the row
  // (#115). Thus the row does not go to the top until the next pull.
  const putList = (row: ListRecord) => {
    const old = state.lists.get(row.id);
    if (old && !differs(old, row)) return;
    state.lists.set(row.id, stamp(row));
    changed.lists.add(row.id);
  };
  const putItem = (row: ItemRecord) => {
    const old = state.items.get(row.id);
    if (old && !differs(old, row)) return;
    state.items.set(row.id, stamp(row));
    changed.items.add(row.id);
  };
  const liveList = (id: string) => {
    const list = state.lists.get(id);
    return list && list.deletedAt === null ? list : undefined;
  };
  const liveItemsOf = (listId: string) =>
    [...state.items.values()].filter(
      (i) => i.listId === listId && i.deletedAt === null,
    );

  switch (op.type) {
    case "createList": {
      const { listId, name } = op.args;
      if (state.lists.has(listId)) break;
      putList({
        id: listId,
        name,
        createdBy: userId,
        createdAt: time,
        updatedBy: userId,
        updatedAt: time,
        updatedVia: "app",
        deletedAt: null,
        summary: null,
        seq: 0,
      });
      break;
    }
    case "renameList": {
      const list = state.lists.get(op.args.listId);
      if (list) putList({ ...list, name: op.args.name, deletedAt: null });
      break;
    }
    case "deleteList": {
      const list = state.lists.get(op.args.listId);
      if (list && list.deletedAt === null)
        putList({ ...list, deletedAt: time });
      break;
    }
    case "restoreList": {
      const list = state.lists.get(op.args.listId);
      if (list && list.deletedAt !== null)
        putList({ ...list, deletedAt: null });
      break;
    }
    case "addItem": {
      const { itemId, listId, name, quantity, notes } = op.args;
      // The server rejects an add to a missing or deleted list.
      if (!liveList(listId) || state.items.has(itemId)) break;
      const key = nameKey(name);
      const match = liveItemsOf(listId)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .find((i) => nameKey(i.name) === key);
      if (match) {
        // Dedupe: the server merges the add into this item.
        if (match.checked) {
          putItem({ ...match, checked: false, checkedAt: null });
        }
        break;
      }
      putItem({
        id: itemId,
        listId,
        name,
        quantity,
        notes,
        checked: false,
        checkedAt: null,
        outOfStockAt: null,
        createdBy: userId,
        createdAt: time,
        updatedBy: userId,
        updatedAt: time,
        updatedVia: "app",
        deletedAt: null,
        seq: 0,
      });
      break;
    }
    case "updateItem": {
      const item = state.items.get(op.args.itemId);
      if (!item) break;
      // An edit that changes the item also unchecks it (#112).
      const { fields } = op.args;
      const changes = (Object.keys(fields) as (keyof typeof fields)[]).some(
        (key) => fields[key] !== undefined && fields[key] !== item[key],
      );
      putItem({
        ...item,
        ...fields,
        ...(changes && { checked: false, checkedAt: null }),
        deletedAt: null,
      });
      break;
    }
    case "check":
    case "uncheck": {
      const item = state.items.get(op.args.itemId);
      if (!item) break;
      const checked = op.type === "check";
      putItem({
        ...item,
        checked,
        checkedAt: checked ? (item.checked ? item.checkedAt : time) : null,
        // An item in the cart is in stock (#131).
        ...(checked && inStock(item)),
        deletedAt: null,
      });
      break;
    }
    case "markOutOfStock": {
      const item = state.items.get(op.args.itemId);
      if (!item) break;
      // The person did not get it: it is not in the cart.
      putItem({
        ...item,
        outOfStockAt: item.outOfStockAt ?? time,
        checked: false,
        checkedAt: null,
        deletedAt: null,
      });
      break;
    }
    case "markInStock": {
      const item = state.items.get(op.args.itemId);
      if (item) putItem({ ...item, ...inStock(item), deletedAt: null });
      break;
    }
    case "deleteItem": {
      const item = state.items.get(op.args.itemId);
      if (item && item.deletedAt === null)
        putItem({ ...item, deletedAt: time });
      break;
    }
    case "restoreItem": {
      const item = state.items.get(op.args.itemId);
      if (item && item.deletedAt !== null)
        putItem({ ...item, deletedAt: null });
      break;
    }
    case "moveItem": {
      const item = state.items.get(op.args.itemId);
      if (!item || !liveList(op.args.toListId)) break;
      // A move to another list also unchecks the item (#112), and marks it
      // in stock (#131).
      const moved = item.listId !== op.args.toListId;
      putItem({
        ...item,
        listId: op.args.toListId,
        ...(moved && { checked: false, checkedAt: null, ...inStock(item) }),
        deletedAt: null,
      });
      break;
    }
    case "clearChecked":
    case "uncheckAll": {
      if (!liveList(op.args.listId)) break;
      for (const item of liveItemsOf(op.args.listId)) {
        if (!item.checked) continue;
        if (op.type === "clearChecked") putItem({ ...item, deletedAt: time });
        else putItem({ ...item, checked: false, checkedAt: null });
      }
      break;
    }
    case "checkAll": {
      if (!liveList(op.args.listId)) break;
      for (const item of liveItemsOf(op.args.listId)) {
        if (!item.checked) {
          putItem({
            ...item,
            checked: true,
            checkedAt: time,
            ...inStock(item),
          });
        }
      }
      break;
    }
  }
  return changed;
}
