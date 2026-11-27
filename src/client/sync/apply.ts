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
  const putList = (row: ListRecord) => {
    state.lists.set(row.id, stamp(row));
    changed.lists.add(row.id);
  };
  const putItem = (row: ItemRecord) => {
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
      if (item) putItem({ ...item, ...op.args.fields, deletedAt: null });
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
        deletedAt: null,
      });
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
      putItem({ ...item, listId: op.args.toListId, deletedAt: null });
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
        if (!item.checked) putItem({ ...item, checked: true, checkedAt: time });
      }
      break;
    }
  }
  return changed;
}
