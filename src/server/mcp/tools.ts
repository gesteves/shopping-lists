// The MCP tools (#19). See "Tools" in docs/PLAN.md.
//
// Rules:
//   - Each write makes ops and calls applyOps with via "mcp". Thus an MCP
//     change merges, syncs, and notifies like a change in the app.
//   - Reads use src/server/queries.ts, and return live rows only.
//   - A tool takes a list (and an item) by ID or by name, case-insensitive.
//   - A business error (an unknown list, a deleted item) is a ToolError.
//     The server returns it as a result with isError: true.
//   - idempotency_key: the op IDs (and the IDs of new rows) come from the
//     key, the user, and the position. Thus a retry with the same key gives
//     "duplicate" results and changes nothing.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "@/db/client";
import type { HlcClock } from "@/shared/hlc";
import { nameKey } from "@/shared/names";
import {
  ITEM_NAME_MAX,
  LIST_NAME_MAX,
  itemName,
  listName,
  notes as notesField,
  opSchema,
  quantity,
  url as urlField,
  type OpInput,
} from "@/shared/ops";
import type { ListRecord, RejectReason, StoredResult } from "@/shared/sync";
import { getServerClock, SERVER_NODE } from "../clock";
import {
  HISTORY_ACTIONS,
  historyAction,
  historyItemNames,
  historyListNames,
  readHistory,
  type HistoryCursor,
  type HistoryRow,
} from "../history";
import { applyOps } from "../ops";
import {
  readListById,
  readListItems,
  readLiveLists,
  readUsers,
  searchLiveItems,
  type ServerItemRecord,
} from "../queries";

export interface ToolContext {
  db: Db;
  /** The token owner. MCP ops are recorded as this user. */
  userId: string;
  /** The OAuth client, for the log only. */
  clientId?: string;
  clock?: HlcClock;
  now?: () => number;
}

/** A business error. The model reads `message`, thus make it helpful. */
export class ToolError extends Error {}

// --- shared schemas ----------------------------------------------------------

// A UUID is shorter than each name limit. The limit also keeps a long text
// out of the error messages, which quote the reference.
const listRef = z
  .string()
  .trim()
  .min(1)
  .max(LIST_NAME_MAX)
  .describe("The list_id, or the list name (case-insensitive)");
const itemRef = z
  .string()
  .trim()
  .min(1)
  .max(ITEM_NAME_MAX)
  .describe("The item_id, or the item name on that list (case-insensitive)");
const itemRefs = z
  .array(itemRef)
  .min(1)
  .max(100)
  .describe("Item IDs or item names on that list");
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Optional. Send the same key when you retry the same call: the retry then changes nothing",
  );
const notes = notesField.describe(
  "Notes, such as a brand or a size. An empty string removes them",
);

const url = urlField.describe(
  "A link to a web page for the item, such as a product page. Only http and https URLs. An empty string removes it",
);

const listOut = z.object({ list_id: z.string(), name: z.string() });
const privateOut = z
  .boolean()
  .describe(
    "True if the list is private: only the user of this connection sees it, and it sends no notifications",
  );
const itemOut = z.object({
  item_id: z.string(),
  name: z.string(),
  quantity: z.int(),
  notes: z.string(),
  url: z.string().describe("A link to a web page for the item, or empty"),
  checked: z.boolean(),
  checked_at: z.iso
    .datetime()
    .nullable()
    .describe(
      "When someone checked the item off (got it). Null if it is not checked",
    ),
  unchecked_at: z.iso
    .datetime()
    .nullable()
    .describe(
      "When the item last went back on the list: someone unchecked it, or added, changed, or moved it while it was checked. Null if it is checked, or if no one unchecked it",
    ),
  out_of_stock: z
    .boolean()
    .describe("True if someone marked the item out of stock at the store"),
});
const addedOut = z.object({ by: z.string(), at: z.iso.datetime() });
const changedOut = addedOut.extend({
  via_claude: z.boolean().describe("True if the change came through Claude"),
});

// --- helpers -------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID from a hash. Version 8 (custom), RFC 9562 variant. */
function derivedUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** JSON with the object keys in order, thus equal values give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Makes the IDs of one tool call: random, or from the idempotency key. The
 * hash has the arguments too (#101): the same key with different arguments
 * gives new IDs, thus it makes the change, or gives an error. A retry with
 * the same key and the same arguments gives the same IDs ("duplicate").
 */
function idMaker(
  ctx: ToolContext,
  tool: string,
  input: { idempotency_key?: string },
) {
  const { idempotency_key: key, ...args } = input;
  const argsHash = key
    ? createHash("sha256").update(canonicalJson(args)).digest("hex")
    : "";
  return (kind: string, index = 0) =>
    key
      ? derivedUuid(ctx.userId, tool, key, argsHash, kind, String(index))
      : randomUUID();
}

function quoteNames(names: string[]): string {
  return names.map((n) => `“${n}”`).join(", ");
}

/** The live list for a reference, or a ToolError. */
export function resolveList(ctx: ToolContext, ref: string): ListRecord {
  if (UUID.test(ref)) {
    const list = readListById(ref.toLowerCase(), ctx.userId, ctx.db);
    if (list && list.deletedAt === null) return list;
    if (list) throw new ToolError(`The list “${list.name}” was deleted.`);
  }
  const live = readLiveLists(ctx.userId, ctx.db).map((l) => l.list);
  const key = nameKey(ref);
  const matches = live.filter((l) => nameKey(l.name) === key);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ToolError(
      `More than one list is named “${ref}”. Use a list_id: ${matches
        .map((l) => l.id)
        .join(", ")}.`,
    );
  }
  throw new ToolError(
    live.length === 0
      ? `No list matches “${ref}”. There are no lists yet: make one with create_list.`
      : `No list matches “${ref}”. The lists are: ${quoteNames(live.map((l) => l.name))}.`,
  );
}

/** The live items for the references, in the same order, or a ToolError. */
function resolveItems(
  ctx: ToolContext,
  list: ListRecord,
  refs: string[],
): ServerItemRecord[] {
  const items = readListItems(list.id, ctx.db);
  const missing: string[] = [];
  const found = refs.flatMap((ref) => {
    const byId = UUID.test(ref)
      ? items.find((i) => i.id === ref.toLowerCase())
      : undefined;
    if (byId) return [byId];
    const key = nameKey(ref);
    const byName = items.filter((i) => nameKey(i.name) === key);
    if (byName.length === 1) return byName;
    if (byName.length > 1) {
      throw new ToolError(
        `More than one item on “${list.name}” is named “${ref}”. Use an item_id: ${byName
          .map((i) => i.id)
          .join(", ")}.`,
      );
    }
    missing.push(ref);
    return [];
  });
  if (missing.length > 0) {
    throw new ToolError(
      `Not on “${list.name}”: ${quoteNames(missing)}. Nothing was changed. Call get_list to see its items.`,
    );
  }
  // One item can match two references. Change it one time.
  return [...new Map(found.map((i) => [i.id, i])).values()];
}

// --- history (#152) -------------------------------------------------------------

const CURSOR = /^(\d{1,15})\.(\d{1,15})$/;

function toCursor(row: HistoryRow): string {
  return `${row.opAt.getTime()}.${row.id}`;
}

function fromCursor(text: string): HistoryCursor {
  const match = CURSOR.exec(text);
  if (!match) {
    throw new ToolError(
      "The cursor is not valid. Send the next_cursor of the last get_history result, with the same filters.",
    );
  }
  return { opAt: Number(match[1]), id: Number(match[2]) };
}

/** A list for get_history: a live list, or one in the history only. */
function resolveHistoryList(
  ctx: ToolContext,
  ref: string,
): { id: string; name: string } {
  const old = historyListNames(ctx.userId, ctx.db);
  if (UUID.test(ref)) {
    const id = ref.toLowerCase();
    const name =
      readListById(id, ctx.userId, ctx.db)?.name ??
      old.find((l) => l.listId === id)?.name;
    if (name !== undefined) return { id, name };
    throw new ToolError(
      `No list, now or in the history, has the list_id ${id}.`,
    );
  }
  const key = nameKey(ref);
  const live = readLiveLists(ctx.userId, ctx.db).map((l) => l.list);
  const liveMatches = live.filter((l) => nameKey(l.name) === key);
  const matches =
    liveMatches.length > 0
      ? liveMatches.map((l) => ({ id: l.id, name: l.name }))
      : [
          ...new Map(
            old
              .filter((l) => l.name !== null && nameKey(l.name) === key)
              .map((l) => [l.listId, { id: l.listId, name: l.name }]),
          ).values(),
        ];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ToolError(
      `More than one list is named “${ref}”. Use a list_id: ${matches
        .map((l) => l.id)
        .join(", ")}.`,
    );
  }
  throw new ToolError(
    `No list, now or in the history, matches “${ref}”. The lists are: ${quoteNames(live.map((l) => l.name))}.`,
  );
}

/**
 * The item IDs for a reference on a list, for get_history: the live items
 * and the items in the history with that name. One name can be more than
 * one item: for example an item that someone deleted and added again.
 */
function resolveHistoryItems(
  ctx: ToolContext,
  list: { id: string; name: string },
  ref: string,
): string[] {
  const old = historyItemNames(list.id, ctx.userId, ctx.db);
  const live = readListItems(list.id, ctx.db);
  if (UUID.test(ref)) {
    const id = ref.toLowerCase();
    if (live.some((i) => i.id === id) || old.some((i) => i.itemId === id)) {
      return [id];
    }
  } else {
    const key = nameKey(ref);
    const ids = new Set([
      ...live.filter((i) => nameKey(i.name) === key).map((i) => i.id),
      ...old
        .filter((i) => i.name !== null && nameKey(i.name) === key)
        .map((i) => i.itemId),
    ]);
    if (ids.size > 0) return [...ids];
  }
  throw new ToolError(
    `No item “${ref}” is on “${list.name}” or in its history. Call get_history with only the list to see its changes.`,
  );
}

/** The user ID for "me" or a name (the full name, or the first word). */
function resolvePerson(ctx: ToolContext, ref: string): string {
  const key = nameKey(ref);
  if (key === "me") return ctx.userId;
  const users = readUsers(ctx.db);
  const full = users.filter((u) => nameKey(u.name) === key);
  const first = users.filter((u) => nameKey(u.name).split(" ")[0] === key);
  const matches = full.length > 0 ? full : first;
  if (matches.length === 1) return matches[0].id;
  throw new ToolError(
    `${matches.length > 1 ? "More than one person" : "No person"} matches “${ref}”. Use "me", or one of: ${quoteNames(users.map((u) => u.name))}.`,
  );
}

function fromTo<T extends z.ZodType>(value: T) {
  return z.object({
    from: value.nullable().describe("The value before, or null if not known"),
    to: value,
  });
}

const historyEntryOut = z.object({
  at: z.iso
    .datetime()
    .describe("When the change was made, on the device of the person"),
  by: z
    .string()
    .nullable()
    .describe(
      "The person. Null for an automatic change: the delete of an item that stayed checked for 30 days",
    ),
  via_claude: z.boolean().describe("True if the change came through Claude"),
  action: z.enum(HISTORY_ACTIONS),
  list_id: z.string(),
  list_name: z.string().describe("The name of the list at the time"),
  item_id: z.string().nullable(),
  item_name: z.string().nullable().describe("The name of the item at the time"),
  changes: z
    .object({
      name: fromTo(z.string()),
      quantity: fromTo(z.int()),
      notes: fromTo(z.string()),
      url: fromTo(z.string()),
    })
    .partial()
    .optional()
    .describe("edited: the fields that changed"),
  from_list_id: z.string().optional().describe("moved: the list before"),
  from_list_name: z.string().optional().describe("moved: the list before"),
  added_again: z
    .boolean()
    .optional()
    .describe(
      "unchecked: someone added the name again while it was checked, and that unchecked it",
    ),
  also_unchecked: z
    .boolean()
    .optional()
    .describe("The change also unchecked the item"),
  also_in_stock: z
    .boolean()
    .optional()
    .describe("The change also marked the item in stock"),
  count: z
    .int()
    .optional()
    .describe(
      "Old rows of a check all, uncheck all, or clear checked: the number of items",
    ),
});

function toHistoryEntry(
  row: HistoryRow,
  names: Map<string, string>,
): z.output<typeof historyEntryOut> {
  const s = row.snapshot;
  const action = historyAction(row.type, s);
  const entry: z.output<typeof historyEntryOut> = {
    at: iso(row.opAt.getTime()),
    by: row.actorId === null ? null : (names.get(row.actorId) ?? "Someone"),
    via_claude: row.via === "mcp",
    action,
    list_id: row.listId,
    list_name: s.listName,
    item_id: row.itemId,
    item_name: s.itemName ?? null,
  };
  if (row.type === "updateItem") {
    const changes: NonNullable<typeof entry.changes> = {};
    if (s.oldName !== undefined && s.itemName !== undefined) {
      changes.name = { from: s.oldName, to: s.itemName };
    }
    if (s.quantity !== undefined) {
      changes.quantity = { from: s.oldQuantity ?? null, to: s.quantity };
    }
    if (s.notes !== undefined) {
      changes.notes = { from: s.oldNotes ?? null, to: s.notes };
    }
    if (s.url !== undefined) {
      changes.url = { from: s.oldUrl ?? null, to: s.url };
    }
    entry.changes = changes;
  }
  if (row.type === "renameList" && s.oldName !== undefined) {
    entry.changes = { name: { from: s.oldName, to: s.listName } };
  }
  if (s.fromListId !== undefined) entry.from_list_id = s.fromListId;
  if (s.fromListName !== undefined) entry.from_list_name = s.fromListName;
  if (row.type === "addItem" && s.unchecked) entry.added_again = true;
  else if (s.unchecked && action !== "unchecked") entry.also_unchecked = true;
  if (s.inStock) entry.also_in_stock = true;
  if (s.count !== undefined) entry.count = s.count;
  return entry;
}

type OpSpec = Pick<OpInput, "type" | "args">;

/** Applies the ops for the caller with via "mcp". One result per op. */
function apply(
  ctx: ToolContext,
  ids: ReturnType<typeof idMaker>,
  specs: OpSpec[],
): StoredResult[] {
  const clock = ctx.clock ?? getServerClock();
  const ops = specs.map((spec, i) =>
    opSchema.parse({
      ...spec,
      opId: ids("op", i),
      clientId: SERVER_NODE,
      hlc: clock.now(),
    }),
  );
  const { results } = applyOps({ id: ctx.userId }, "mcp", ops, {
    db: ctx.db,
    clock,
    now: ctx.now,
  });
  return results.map((r) => {
    const stored = r.status === "duplicate" ? r.original : r;
    if (stored.status === "rejected") {
      throw new ToolError(REJECTED[stored.reason]);
    }
    return stored;
  });
}

/** The item count of a result: the items that the op changed. */
function countOf(result: StoredResult): number {
  return result.status === "applied" ? (result.count ?? 0) : 0;
}

const REJECTED: Record<RejectReason, string> = {
  list_not_found: "The list does not exist. Call list_lists to see the lists.",
  list_deleted: "The list was deleted.",
  list_exists: "A list with this ID exists. Try again without the same key.",
  item_not_found: "The item does not exist. Call get_list to see the items.",
  item_exists: "An item with this ID exists. Try again without the same key.",
  clock_ahead: "The server clock is not ready. Try again in a minute.",
  op_conflict:
    "This change has the ID of a change of another user. Try again with a new idempotency_key.",
  not_owner: "Only the person who made the list can make it private or shared.",
  privacy_mismatch:
    "An item cannot move between a private list and a shared list. Add it to the other list with add_items instead, and delete it here if the user wants.",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toItemOut(item: ServerItemRecord) {
  return {
    item_id: item.id,
    name: item.name,
    quantity: item.quantity,
    notes: item.notes,
    url: item.url,
    checked: item.checked,
    checked_at: item.checkedAt === null ? null : iso(item.checkedAt),
    unchecked_at: item.uncheckedAt === null ? null : iso(item.uncheckedAt),
    out_of_stock: item.outOfStockAt !== null,
  };
}

// --- the tools -------------------------------------------------------------------

interface Annotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolDef<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> {
  name: string;
  title: string;
  description: string;
  scope: "lists:read" | "lists:write";
  annotations: Annotations;
  input: I;
  output: O;
  run: (ctx: ToolContext, args: z.output<I>) => z.output<O>;
}

function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  def: ToolDef<I, O>,
): ToolDef<I, O> {
  return def;
}

const READ = { readOnlyHint: true } as const;

/** The tools, in the order of tools/list. */
export const TOOLS = [
  defineTool({
    name: "list_lists",
    title: "List the shopping lists",
    description:
      "All shopping lists, by name, with the number of items and of unchecked items. It includes the private lists of the user.",
    scope: "lists:read",
    annotations: READ,
    input: z.object({}),
    output: z.object({
      lists: z.array(
        listOut.extend({
          private: privateOut,
          items: z.int(),
          unchecked: z.int(),
        }),
      ),
    }),
    run: (ctx) => ({
      lists: readLiveLists(ctx.userId, ctx.db).map((l) => ({
        list_id: l.list.id,
        name: l.list.name,
        private: l.list.private,
        items: l.itemCount,
        unchecked: l.uncheckedCount,
      })),
    }),
  }),

  defineTool({
    name: "get_list",
    title: "Get a shopping list",
    description:
      "The items of one list: unchecked first, then the most recently changed first. Each item says who added it and who changed it last, and when, and when it was checked off or unchecked.",
    scope: "lists:read",
    annotations: READ,
    input: z.object({
      list: listRef,
      include_checked: z
        .boolean()
        .default(true)
        .describe("False to get only the unchecked items"),
    }),
    output: listOut.extend({
      private: privateOut,
      items: z.array(
        itemOut.extend({ added: addedOut, last_changed: changedOut }),
      ),
    }),
    run: (ctx, { list: ref, include_checked }) => {
      const list = resolveList(ctx, ref);
      const names = new Map(readUsers(ctx.db).map((u) => [u.id, u.name]));
      const who = (id: string) => names.get(id) ?? "Someone";
      const items = readListItems(list.id, ctx.db).filter(
        (i) => include_checked || !i.checked,
      );
      return {
        list_id: list.id,
        name: list.name,
        private: list.private,
        items: items.map((item) => ({
          ...toItemOut(item),
          added: { by: who(item.createdBy), at: iso(item.createdAt) },
          last_changed: {
            by: who(item.updatedBy),
            via_claude: item.updatedVia === "mcp",
            at: iso(item.updatedAt),
          },
        })),
      };
    },
  }),

  defineTool({
    name: "search_items",
    title: "Search items",
    description:
      "Find items on all lists whose name contains the text (case-insensitive). At most 50 results, unchecked first.",
    scope: "lists:read",
    annotations: READ,
    input: z.object({ query: z.string().trim().min(1).max(ITEM_NAME_MAX) }),
    output: z.object({
      items: z.array(
        itemOut.extend({ list_id: z.string(), list_name: z.string() }),
      ),
    }),
    run: (ctx, { query }) => ({
      items: searchLiveItems(nameKey(query), 50, ctx.userId, ctx.db).map(
        (r) => ({
          ...toItemOut(r.item),
          list_id: r.item.listId,
          list_name: r.listName,
        }),
      ),
    }),
  }),

  defineTool({
    name: "get_history",
    title: "Get the history of changes",
    description:
      'The changes to the lists and items: who did what, and when, the last change first. It includes deleted lists and items. Each filter is optional, and all filters apply together. For example, "what did I buy last week" is actions ["checked"], person "me", and since and until; "who deleted the eggs?" is the list, item "eggs", and actions ["deleted", "expired"]. Results come in pages: for more, call again with the same filters and next_cursor.',
    scope: "lists:read",
    annotations: READ,
    input: z.object({
      list: listRef
        .optional()
        .describe(
          "Only this list: its list_id or name, also for a deleted list. Includes the moves out of it",
        ),
      item: itemRef
        .optional()
        .describe(
          "Only this item: its item_id or name, also for a deleted item. Needs list",
        ),
      person: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Only the changes of this person: "me" (the user of this connection), or a name',
        ),
      actions: z
        .array(z.enum(HISTORY_ACTIONS))
        .min(1)
        .optional()
        .describe("Only these actions"),
      since: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("Only changes at or after this time"),
      until: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("Only changes before this time"),
      limit: z.int().min(1).max(200).default(50),
      cursor: z
        .string()
        .max(100)
        .optional()
        .describe("The next_cursor of the last result, for the next page"),
    }),
    output: z.object({
      entries: z.array(historyEntryOut),
      next_cursor: z
        .string()
        .nullable()
        .describe("For the next page, or null if there are no more"),
    }),
    run: (ctx, input) => {
      if (input.item !== undefined && input.list === undefined) {
        throw new ToolError("Give the list of the item too.");
      }
      const list =
        input.list === undefined
          ? undefined
          : resolveHistoryList(ctx, input.list);
      const rows = readHistory(
        {
          userId: ctx.userId,
          listId: list?.id,
          itemIds:
            list && input.item !== undefined
              ? resolveHistoryItems(ctx, list, input.item)
              : undefined,
          actorId:
            input.person === undefined
              ? undefined
              : resolvePerson(ctx, input.person),
          actions: input.actions,
          since:
            input.since === undefined ? undefined : Date.parse(input.since),
          until:
            input.until === undefined ? undefined : Date.parse(input.until),
          before:
            input.cursor === undefined ? undefined : fromCursor(input.cursor),
          limit: input.limit + 1,
        },
        ctx.db,
      );
      const page = rows.slice(0, input.limit);
      const names = new Map(readUsers(ctx.db).map((u) => [u.id, u.name]));
      return {
        entries: page.map((row) => toHistoryEntry(row, names)),
        next_cursor: rows.length > input.limit ? toCursor(page.at(-1)!) : null,
      };
    },
  }),

  defineTool({
    name: "create_list",
    title: "Create a list",
    description:
      "Make a new shopping list. Returns its list_id. Fails if a list with the same name exists. A private list is only for the user: the other person does not see it, and it sends no notifications. Use it for a surprise, such as gifts.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    input: z.object({
      name: listName,
      private: z
        .boolean()
        .default(false)
        .describe("True to make a private list. Default false (shared)"),
      idempotency_key: idempotencyKey,
    }),
    output: listOut.extend({ private: privateOut }),
    run: (ctx, input) => {
      const { name } = input;
      const ids = idMaker(ctx, "create_list", input);
      const listId = ids("list");
      const same = readLiveLists(ctx.userId, ctx.db).find(
        (l) => nameKey(l.list.name) === nameKey(name) && l.list.id !== listId,
      );
      if (same) {
        throw new ToolError(
          `A list named “${same.list.name}” exists (list_id ${same.list.id}). Use it, or pick another name.`,
        );
      }
      apply(ctx, ids, [
        {
          type: "createList",
          args: { listId, name, private: input.private },
        },
      ]);
      const list = readListById(listId, ctx.userId, ctx.db)!;
      return { list_id: listId, name: list.name, private: list.private };
    },
  }),

  defineTool({
    name: "rename_list",
    title: "Rename a list",
    description: "Change the name of a list.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: z.object({
      list: listRef,
      name: listName,
      idempotency_key: idempotencyKey,
    }),
    output: listOut,
    run: (ctx, input) => {
      const { list: ref, name } = input;
      const list = resolveList(ctx, ref);
      apply(ctx, idMaker(ctx, "rename_list", input), [
        { type: "renameList", args: { listId: list.id, name } },
      ]);
      return {
        list_id: list.id,
        name: readListById(list.id, ctx.userId, ctx.db)!.name,
      };
    },
  }),

  defineTool({
    name: "set_list_private",
    title: "Make a list private or shared",
    description:
      "Make a list private (only the user sees it and its items, and it sends no notifications), or share it again. Only the person who made the list can. When a list becomes private, it goes away at once for the other person, also the items that they added: confirm with the user first. When it is shared again, the other person sees it with all its items and its history, and gets a notification.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: z.object({
      list: listRef,
      private: z.boolean().describe("True for private, false for shared"),
      idempotency_key: idempotencyKey,
    }),
    output: listOut.extend({ private: privateOut }),
    run: (ctx, input) => {
      const list = resolveList(ctx, input.list);
      apply(ctx, idMaker(ctx, "set_list_private", input), [
        {
          type: "setListPrivate",
          args: { listId: list.id, private: input.private },
        },
      ]);
      const after = readListById(list.id, ctx.userId, ctx.db)!;
      return { list_id: list.id, name: after.name, private: after.private };
    },
  }),

  defineTool({
    name: "delete_list",
    title: "Delete a list",
    description:
      "Delete a list and all its items, for both people (only for the user, if the list is private). Confirm with the user first.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    input: z.object({ list: listRef, idempotency_key: idempotencyKey }),
    output: listOut.extend({ deleted_items: z.int() }),
    run: (ctx, input) => {
      const { list: ref } = input;
      const list = resolveList(ctx, ref);
      const [result] = apply(ctx, idMaker(ctx, "delete_list", input), [
        { type: "deleteList", args: { listId: list.id } },
      ]);
      return {
        list_id: list.id,
        name: list.name,
        deleted_items: countOf(result),
      };
    },
  }),

  defineTool({
    name: "add_items",
    title: "Add items",
    description:
      "Add items to a list. An item whose name is already on the list is not added again: if it was checked off, it is unchecked. Its quantity, notes, and url do not change; use update_item for that.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    input: z.object({
      list: listRef,
      items: z
        .array(
          z.object({
            name: itemName,
            quantity: quantity.optional().describe("Default 1"),
            notes: notes.optional(),
            url: url.optional(),
          }),
        )
        .min(1)
        .max(100),
      idempotency_key: idempotencyKey,
    }),
    output: listOut.extend({
      items: z.array(
        z.object({
          item_id: z.string(),
          name: z.string(),
          result: z.enum(["added", "already_on_list"]),
        }),
      ),
    }),
    run: (ctx, input) => {
      const { list: ref, items } = input;
      const list = resolveList(ctx, ref);
      const ids = idMaker(ctx, "add_items", input);
      const specs = items.map((item, i) => ({
        type: "addItem" as const,
        args: {
          itemId: ids("item", i),
          listId: list.id,
          name: item.name,
          ...(item.quantity !== undefined && { quantity: item.quantity }),
          ...(item.notes !== undefined && { notes: item.notes }),
          ...(item.url !== undefined && { url: item.url }),
        },
      }));
      const results = apply(ctx, ids, specs);
      const byId = new Map(
        readListItems(list.id, ctx.db).map((i) => [i.id, i]),
      );
      return {
        list_id: list.id,
        name: list.name,
        items: results.map((r, i) => {
          const itemId = r.status === "merged" ? r.into : specs[i].args.itemId;
          return {
            item_id: itemId,
            name: byId.get(itemId)?.name ?? specs[i].args.name,
            result:
              r.status === "merged"
                ? ("already_on_list" as const)
                : ("added" as const),
          };
        }),
      };
    },
  }),

  defineTool({
    name: "update_item",
    title: "Update an item",
    description:
      "Change the name, the quantity, the notes, or the url of an item, or mark it out of stock or in stock. A change to a checked item also unchecks it, because the person is going to buy it again. Marking an item out of stock also unchecks it.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: z.object({
      list: listRef,
      item: itemRef,
      name: itemName.optional(),
      quantity: quantity.optional(),
      notes: notes.optional(),
      url: url.optional(),
      out_of_stock: z
        .boolean()
        .optional()
        .describe(
          "True if the store did not have the item, false when it is available again",
        ),
      idempotency_key: idempotencyKey,
    }),
    output: itemOut,
    run: (ctx, input) => {
      const {
        list: ref,
        item: itemArg,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- not a field
        idempotency_key,
        out_of_stock,
        ...fields
      } = input;
      const list = resolveList(ctx, ref);
      const [item] = resolveItems(ctx, list, [itemArg]);
      const set = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const specs: OpSpec[] = [];
      if (Object.keys(set).length > 0) {
        specs.push({
          type: "updateItem",
          args: { itemId: item.id, fields: set },
        });
      }
      if (out_of_stock !== undefined) {
        specs.push({
          type: out_of_stock ? "markOutOfStock" : "markInStock",
          args: { itemId: item.id },
        });
      }
      if (specs.length === 0) {
        throw new ToolError(
          "Give a name, a quantity, notes, a url, or out_of_stock to change.",
        );
      }
      apply(ctx, idMaker(ctx, "update_item", input), specs);
      const after = readListItems(list.id, ctx.db).find(
        (i) => i.id === item.id,
      );
      return toItemOut(after ?? item);
    },
  }),

  ...(["check_items", "uncheck_items"] as const).map((name) =>
    defineTool({
      name,
      title: name === "check_items" ? "Check off items" : "Uncheck items",
      description:
        name === "check_items"
          ? "Check items off a list, as when they are in the cart. This also marks them in stock."
          : "Uncheck items, so they are to buy again.",
      scope: "lists:write",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      input: z.object({
        list: listRef,
        items: itemRefs,
        idempotency_key: idempotencyKey,
      }),
      output: listOut.extend({ items: z.array(itemOut) }),
      run: (ctx, input) => {
        const { list: ref, items: refs } = input;
        const list = resolveList(ctx, ref);
        const items = resolveItems(ctx, list, refs);
        apply(
          ctx,
          idMaker(ctx, name, input),
          items.map((i) => ({
            type:
              name === "check_items"
                ? ("check" as const)
                : ("uncheck" as const),
            args: { itemId: i.id },
          })),
        );
        const now = new Map(
          readListItems(list.id, ctx.db).map((i) => [i.id, i]),
        );
        return {
          list_id: list.id,
          name: list.name,
          items: items.map((i) => toItemOut(now.get(i.id) ?? i)),
        };
      },
    }),
  ),

  defineTool({
    name: "delete_items",
    title: "Delete items",
    description:
      "Remove items from a list, for both people. Confirm with the user first.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    input: z.object({
      list: listRef,
      items: itemRefs,
      idempotency_key: idempotencyKey,
    }),
    output: listOut.extend({
      deleted: z.array(z.object({ item_id: z.string(), name: z.string() })),
    }),
    run: (ctx, input) => {
      const { list: ref, items: refs } = input;
      const list = resolveList(ctx, ref);
      const items = resolveItems(ctx, list, refs);
      apply(
        ctx,
        idMaker(ctx, "delete_items", input),
        items.map((i) => ({
          type: "deleteItem" as const,
          args: { itemId: i.id },
        })),
      );
      return {
        list_id: list.id,
        name: list.name,
        deleted: items.map((i) => ({ item_id: i.id, name: i.name })),
      };
    },
  }),

  defineTool({
    name: "move_item",
    title: "Move an item",
    description:
      "Move an item from one list to another list. The move unchecks a checked item, and marks an out-of-stock item in stock. Both lists must be private, or both shared: to get an item across, use add_items on the other list.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    input: z.object({
      list: listRef.describe("The list that has the item now: list_id or name"),
      item: itemRef,
      to_list: listRef.describe("The list to move it to: list_id or name"),
      idempotency_key: idempotencyKey,
    }),
    output: itemOut.extend({
      from_list_id: z.string(),
      to_list_id: z.string(),
    }),
    run: (ctx, input) => {
      const { list: ref, item: itemArg, to_list } = input;
      const from = resolveList(ctx, ref);
      const [item] = resolveItems(ctx, from, [itemArg]);
      const to = resolveList(ctx, to_list);
      if (to.id !== from.id) {
        apply(ctx, idMaker(ctx, "move_item", input), [
          { type: "moveItem", args: { itemId: item.id, toListId: to.id } },
        ]);
      }
      // A move unchecks the item: return it as it is now.
      const after = readListItems(to.id, ctx.db).find((i) => i.id === item.id);
      return {
        ...toItemOut(after ?? item),
        from_list_id: from.id,
        to_list_id: to.id,
      };
    },
  }),

  ...(["clear_checked", "uncheck_all"] as const).map((name) =>
    defineTool({
      name,
      title:
        name === "clear_checked" ? "Delete checked items" : "Uncheck all items",
      description:
        name === "clear_checked"
          ? "Delete all checked items from a list, for both people. Confirm with the user first."
          : "Uncheck all items of a list, to shop for them again.",
      scope: "lists:write",
      annotations:
        name === "clear_checked"
          ? {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
            }
          : {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
            },
      input: z.object({ list: listRef, idempotency_key: idempotencyKey }),
      output: listOut.extend({ changed_items: z.int() }),
      run: (ctx, input) => {
        const { list: ref } = input;
        const list = resolveList(ctx, ref);
        const [result] = apply(ctx, idMaker(ctx, name, input), [
          {
            type:
              name === "clear_checked"
                ? ("clearChecked" as const)
                : ("uncheckAll" as const),
            args: { listId: list.id },
          },
        ]);
        return {
          list_id: list.id,
          name: list.name,
          changed_items: countOf(result),
        };
      },
    }),
  ),
];
