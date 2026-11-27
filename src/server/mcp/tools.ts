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
  itemName,
  listName,
  notes as notesField,
  opSchema,
  quantity,
  type OpInput,
} from "@/shared/ops";
import type {
  ItemRecord,
  ListRecord,
  RejectReason,
  StoredResult,
} from "@/shared/sync";
import { getServerClock, SERVER_NODE } from "../clock";
import { applyOps } from "../ops";
import {
  readListById,
  readListItems,
  readLiveLists,
  readUsers,
  searchLiveItems,
} from "../queries";

export interface ToolContext {
  db: Db;
  /** The token owner. MCP ops are recorded as this user. */
  userId: string;
  clock?: HlcClock;
  now?: () => number;
}

/** A business error. The model reads `message`, thus make it helpful. */
export class ToolError extends Error {}

// --- shared schemas ----------------------------------------------------------

const listRef = z
  .string()
  .trim()
  .min(1)
  .describe("The list_id, or the list name (case-insensitive)");
const itemRef = z
  .string()
  .trim()
  .min(1)
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

const listOut = z.object({ list_id: z.string(), name: z.string() });
const itemOut = z.object({
  item_id: z.string(),
  name: z.string(),
  quantity: z.int(),
  notes: z.string(),
  checked: z.boolean(),
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
    const list = readListById(ref.toLowerCase(), ctx.db);
    if (list && list.deletedAt === null) return list;
    if (list) throw new ToolError(`The list “${list.name}” was deleted.`);
  }
  const live = readLiveLists(ctx.db).map((l) => l.list);
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
): ItemRecord[] {
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
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toItemOut(item: ItemRecord) {
  return {
    item_id: item.id,
    name: item.name,
    quantity: item.quantity,
    notes: item.notes,
    checked: item.checked,
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
      "All shopping lists, by name, with the number of items and of unchecked items.",
    scope: "lists:read",
    annotations: READ,
    input: z.object({}),
    output: z.object({
      lists: z.array(listOut.extend({ items: z.int(), unchecked: z.int() })),
    }),
    run: (ctx) => ({
      lists: readLiveLists(ctx.db).map((l) => ({
        list_id: l.list.id,
        name: l.list.name,
        items: l.itemCount,
        unchecked: l.uncheckedCount,
      })),
    }),
  }),

  defineTool({
    name: "get_list",
    title: "Get a shopping list",
    description:
      "The items of one list: unchecked first, then the most recently changed first. Each item says who added it and who changed it last, and when.",
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
      items: searchLiveItems(nameKey(query), 50, ctx.db).map((r) => ({
        ...toItemOut(r.item),
        list_id: r.item.listId,
        list_name: r.listName,
      })),
    }),
  }),

  defineTool({
    name: "create_list",
    title: "Create a list",
    description:
      "Make a new shopping list. Returns its list_id. Fails if a list with the same name exists.",
    scope: "lists:write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    input: z.object({ name: listName, idempotency_key: idempotencyKey }),
    output: listOut,
    run: (ctx, input) => {
      const { name } = input;
      const ids = idMaker(ctx, "create_list", input);
      const listId = ids("list");
      const same = readLiveLists(ctx.db).find(
        (l) => nameKey(l.list.name) === nameKey(name) && l.list.id !== listId,
      );
      if (same) {
        throw new ToolError(
          `A list named “${same.list.name}” exists (list_id ${same.list.id}). Use it, or pick another name.`,
        );
      }
      apply(ctx, ids, [{ type: "createList", args: { listId, name } }]);
      return { list_id: listId, name: readListById(listId, ctx.db)!.name };
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
      return { list_id: list.id, name: readListById(list.id, ctx.db)!.name };
    },
  }),

  defineTool({
    name: "delete_list",
    title: "Delete a list",
    description:
      "Delete a list and all its items, for both people. Confirm with the user first.",
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
      "Add items to a list. An item whose name is already on the list is not added again: if it was checked off, it is unchecked. Its quantity and notes do not change; use update_item for that.",
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
      "Change the name, the quantity, or the notes of an item. A change to a checked item also unchecks it, because the person is going to buy it again.",
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
      idempotency_key: idempotencyKey,
    }),
    output: itemOut,
    run: (ctx, input) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- not a field
      const { list: ref, item: itemArg, idempotency_key, ...fields } = input;
      const list = resolveList(ctx, ref);
      const [item] = resolveItems(ctx, list, [itemArg]);
      const set = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(set).length === 0) {
        throw new ToolError("Give a name, a quantity, or notes to change.");
      }
      apply(ctx, idMaker(ctx, "update_item", input), [
        { type: "updateItem", args: { itemId: item.id, fields: set } },
      ]);
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
          ? "Check items off a list, as when they are in the cart."
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
      "Move an item from one list to another list. A checked item is unchecked by the move.",
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
      return { ...toItemOut(item), from_list_id: from.id, to_list_id: to.id };
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
