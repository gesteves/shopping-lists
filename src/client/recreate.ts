// "Re-create the list" (#104): adds and moves to a list that someone
// deleted while this device was offline. One toast and one new list for
// each deleted list, with all its items (#120). See "Conflict rules" in
// docs/PLAN.md.
import { copy } from "@/copy";
import { nameKey } from "@/shared/names";
import type { Op } from "@/shared/ops";
import { getClientDb } from "./db";
import { mutate } from "./sync";

export interface RecreateItem {
  name: string;
  kind: "add" | "move";
}

export interface Recreate {
  /** The deleted list. */
  listId: string;
  listName: string;
  items: RecreateItem[];
  /** Make one new list with the same name, and add or move each item to it. */
  run: () => Promise<string>;
}

type ListOp = Extract<Op, { type: "addItem" | "moveItem" }>;

/** The list of an add or a move, or null for a different op. */
export function targetList(op: Op): string | null {
  if (op.type === "addItem") return op.args.listId;
  if (op.type === "moveItem") return op.args.toListId;
  return null;
}

/**
 * The re-create action for the refused ops of one deleted list, or null.
 * A new list, not a restore: a restore brings back each item that the
 * other person deleted with the list. An op that is there two times, or
 * an add of a name that is there already, counts one time.
 */
export async function recreateFor(ops: Op[]): Promise<Recreate | null> {
  const listId = ops.map(targetList).find((id) => id !== null);
  if (!listId) return null;
  const db = getClientDb();
  const list =
    (await db.serverLists.get(listId)) ?? (await db.lists.get(listId));
  if (!list) return null;

  const keys = new Set<string>();
  const todo: { op: ListOp; item: RecreateItem }[] = [];
  for (const op of ops) {
    if (targetList(op) !== listId) continue;
    const listOp = op as ListOp;
    const name =
      listOp.type === "addItem"
        ? listOp.args.name
        : ((await db.items.get(listOp.args.itemId))?.name ??
          (await db.serverItems.get(listOp.args.itemId))?.name);
    if (name === undefined) continue;
    const key =
      listOp.type === "addItem"
        ? `add:${nameKey(name)}`
        : `move:${listOp.args.itemId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    todo.push({
      op: listOp,
      item: { name, kind: listOp.type === "addItem" ? "add" : "move" },
    });
  }
  if (todo.length === 0) return null;

  return {
    listId,
    listName: list.name,
    items: todo.map((t) => t.item),
    run: async () => {
      const newListId = crypto.randomUUID();
      await mutate({
        type: "createList",
        args: { listId: newListId, name: list.name },
      });
      for (const { op } of todo) {
        if (op.type === "addItem") {
          await mutate({
            type: "addItem",
            args: {
              ...op.args,
              itemId: crypto.randomUUID(),
              listId: newListId,
            },
          });
        } else {
          await mutate({
            type: "moveItem",
            args: { itemId: op.args.itemId, toListId: newListId },
          });
        }
      }
      return newListId;
    },
  };
}

/** The toast text of a re-create action. */
export function recreateMessage({ listName, items }: Recreate): string {
  if (items.length === 1) {
    const [item] = items;
    return (
      item.kind === "add"
        ? copy.toasts.listDeletedAdd
        : copy.toasts.listDeletedMove
    )(listName, item.name);
  }
  const kinds = new Set(items.map((i) => i.kind));
  return copy.toasts.listDeletedMany(
    listName,
    items.length,
    kinds.size > 1 ? "mixed" : items[0].kind,
  );
}

export interface RecreateGroupsOptions {
  /** Show the toast of a group. Gives the toast ID. */
  show: (recreate: Recreate) => number;
  /** Show the toast of a group with no re-create action (no local list). */
  showFallback: () => number;
  /** True while the toast is on the screen. */
  isShown: (toastId: number) => boolean;
  dismiss: (toastId: number) => void;
  /** The wait for more refused ops before the toast shows. */
  delayMs?: number;
}

/**
 * Groups the refused adds and moves by their deleted list. The engine
 * sends one "rejected" event for each op. The ops of a push come at the
 * same time, thus they wait `delayMs`, then show one toast. An op that
 * comes later, while the toast of its list is on the screen, replaces the
 * toast with one for all the ops.
 */
export class RecreateGroups {
  readonly #options: RecreateGroupsOptions;
  readonly #pending = new Map<string, Op[]>();
  readonly #shown = new Map<string, { ops: Op[]; toastId: number }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** One flush at a time: a flush reads `#shown` after an await. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: RecreateGroupsOptions) {
    this.#options = options;
  }

  /** Add a refused op. False if it is not an add or a move. */
  add(op: Op): boolean {
    const listId = targetList(op);
    if (listId === null) return false;
    const ops = this.#pending.get(listId) ?? [];
    ops.push(op);
    this.#pending.set(listId, ops);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, this.#options.delayMs ?? 300);
    return true;
  }

  /** Show the toasts of the ops that wait. Gives a promise for tests. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const groups = [...this.#pending];
    this.#pending.clear();
    this.#chain = this.#chain
      .then(() => this.#show(groups))
      .catch((error: unknown) => console.error(error));
    return this.#chain;
  }

  async #show(groups: [string, Op[]][]) {
    const { show, showFallback, isShown, dismiss } = this.#options;
    for (const [listId, ops] of groups) {
      const previous = this.#shown.get(listId);
      const open = previous !== undefined && isShown(previous.toastId);
      const all = open ? [...previous.ops, ...ops] : ops;
      const recreate = await recreateFor(all);
      if (open) dismiss(previous.toastId);
      const toastId = recreate ? show(recreate) : showFallback();
      this.#shown.set(listId, { ops: all, toastId });
    }
  }
}
