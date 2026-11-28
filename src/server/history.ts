// The history of the lists and items (#152): the activity rows, as the
// get_history MCP tool reads them. See "Tools" in docs/PLAN.md.
//
// An action is the name that the history shows for a row. One action can
// be more than one row type: a check and a check all are both "checked".
// An add of a name that is checked on the list only unchecks the item
// (#133), thus it is "unchecked", not "added".
import "server-only";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type Reader } from "@/db/client";
import {
  activity,
  type ActivitySnapshot,
  type ActivityType,
} from "@/db/schema";

export const HISTORY_ACTIONS = [
  "added",
  "edited",
  "checked",
  "unchecked",
  "moved",
  "out_of_stock",
  "in_stock",
  "deleted",
  "restored",
  "expired",
  "list_created",
  "list_renamed",
  "list_deleted",
  "list_restored",
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/**
 * The action of each row type. addItem is "added", or "unchecked" if the
 * add only unchecked the item (historyAction, actionWhere).
 */
const ACTION: Record<Exclude<ActivityType, "addItem">, HistoryAction> = {
  updateItem: "edited",
  check: "checked",
  checkAll: "checked",
  uncheck: "unchecked",
  uncheckAll: "unchecked",
  moveItem: "moved",
  markOutOfStock: "out_of_stock",
  markInStock: "in_stock",
  deleteItem: "deleted",
  clearChecked: "deleted",
  restoreItem: "restored",
  expireItem: "expired",
  createList: "list_created",
  renameList: "list_renamed",
  deleteList: "list_deleted",
  restoreList: "list_restored",
};

/** The action of a row. */
export function historyAction(
  type: ActivityType,
  snapshot: ActivitySnapshot,
): HistoryAction {
  if (type === "addItem") return snapshot.unchecked ? "unchecked" : "added";
  return ACTION[type];
}

const reAdd = sql`coalesce(json_extract(${activity.snapshot}, '$.unchecked'), 0) = 1`;

/** The rows of the actions. */
function actionWhere(actions: readonly HistoryAction[]): SQL | undefined {
  const types = (Object.keys(ACTION) as (keyof typeof ACTION)[]).filter(
    (type) => actions.includes(ACTION[type]),
  );
  const parts: SQL[] = [];
  if (types.length > 0) parts.push(inArray(activity.type, types));
  const added = actions.includes("added");
  const unchecked = actions.includes("unchecked");
  if (added && unchecked) parts.push(eq(activity.type, "addItem"));
  else if (added)
    parts.push(and(eq(activity.type, "addItem"), sql`not ${reAdd}`)!);
  else if (unchecked) parts.push(and(eq(activity.type, "addItem"), reAdd)!);
  return or(...parts);
}

/** A place in the history: the rows before it come next. */
export interface HistoryCursor {
  opAt: number;
  id: number;
}

export interface HistoryQuery {
  /** The rows of this list, also the moves out of it. */
  listId?: string;
  /** The rows of these items. */
  itemIds?: string[];
  actorId?: string;
  actions?: readonly HistoryAction[];
  /** Op time in ms: at or after. */
  since?: number;
  /** Op time in ms: before. */
  until?: number;
  before?: HistoryCursor;
  limit: number;
}

export type HistoryRow = typeof activity.$inferSelect;

/** The rows of the history, the last change first (op time, then ID). */
export function readHistory(
  query: HistoryQuery,
  db: Reader = getDb(),
): HistoryRow[] {
  const where: (SQL | undefined)[] = [];
  if (query.listId !== undefined) {
    where.push(
      or(
        eq(activity.listId, query.listId),
        sql`json_extract(${activity.snapshot}, '$.fromListId') = ${query.listId}`,
      ),
    );
  }
  if (query.itemIds !== undefined) {
    where.push(inArray(activity.itemId, query.itemIds));
  }
  if (query.actorId !== undefined) {
    where.push(eq(activity.actorId, query.actorId));
  }
  if (query.actions !== undefined && query.actions.length > 0) {
    where.push(actionWhere(query.actions));
  }
  if (query.since !== undefined) {
    where.push(gte(activity.opAt, new Date(query.since)));
  }
  if (query.until !== undefined) {
    where.push(lt(activity.opAt, new Date(query.until)));
  }
  if (query.before !== undefined) {
    const at = new Date(query.before.opAt);
    where.push(
      or(
        lt(activity.opAt, at),
        and(eq(activity.opAt, at), lt(activity.id, query.before.id)),
      ),
    );
  }
  return db
    .select()
    .from(activity)
    .where(and(...where))
    .orderBy(desc(activity.opAt), desc(activity.id))
    .limit(query.limit)
    .all();
}

/**
 * The IDs and names of the lists in the history, also of deleted and
 * purged lists. The last name of each list is first.
 */
export function historyListNames(
  db: Reader = getDb(),
): { listId: string; name: string }[] {
  return db
    .select({
      listId: activity.listId,
      name: sql<string>`json_extract(${activity.snapshot}, '$.listName')`,
    })
    .from(activity)
    .groupBy(activity.listId, sql`2`)
    .orderBy(desc(sql`max(${activity.id})`))
    .all();
}

/**
 * The IDs and names of the items in the history of a list, also of
 * deleted and purged items.
 */
export function historyItemNames(
  listId: string,
  db: Reader = getDb(),
): { itemId: string; name: string }[] {
  return db
    .select({
      itemId: sql<string>`${activity.itemId}`,
      name: sql<string>`json_extract(${activity.snapshot}, '$.itemName')`,
    })
    .from(activity)
    .where(
      and(
        sql`${activity.itemId} is not null`,
        or(
          eq(activity.listId, listId),
          sql`json_extract(${activity.snapshot}, '$.fromListId') = ${listId}`,
        ),
      ),
    )
    .groupBy(activity.itemId, sql`2`)
    .all();
}
