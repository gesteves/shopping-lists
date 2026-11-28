// The op format. The app (through sync), the MCP tools, and the server all
// write with these ops, and applyOps (#5) applies them.
//
// This file imports only zod and other shared files. The browser and the
// server both use it.
import { z } from "zod";
import { NODE_PATTERN, isHlc, parse } from "./hlc";
import { URL_MAX, isWebUrl } from "./url";

export const LIST_NAME_MAX = 100;
export const ITEM_NAME_MAX = 200;
export const NOTES_MAX = 2000;
export const QUANTITY_MAX = 999;

/** How a change got to the server. "mcp" shows as "(via Claude)". */
export const VIA = ["app", "mcp"] as const;
export type Via = (typeof VIA)[number];

// The fields that have their own HLC clock. Each row keeps one clock for
// each field in its `clocks` JSON. "deleted" is the clock of `deleted_at`,
// "listId" is the clock of a move, and "outOfStock" is the clock of
// `out_of_stock_at` (#131). "url" is the link of the item (#140).
export const LIST_FIELDS = ["name", "deleted"] as const;
export const ITEM_FIELDS = [
  "listId",
  "name",
  "quantity",
  "notes",
  "url",
  "checked",
  "deleted",
  "outOfStock",
] as const;
export type ListField = (typeof LIST_FIELDS)[number];
export type ItemField = (typeof ITEM_FIELDS)[number];
export type ListClocks = Partial<Record<ListField, string>>;
export type ItemClocks = Partial<Record<ItemField, string>>;

const id = z.uuid();
// The field schemas. The MCP tools (src/server/mcp/tools.ts) use them too.
export const listName = z.string().trim().min(1).max(LIST_NAME_MAX);
export const itemName = z.string().trim().min(1).max(ITEM_NAME_MAX);
export const quantity = z.int().min(1).max(QUANTITY_MAX);
/** An empty string removes the notes. */
export const notes = z.string().trim().max(NOTES_MAX);
/** An http or https URL (#140). An empty string removes the link. */
export const url = z
  .string()
  .trim()
  .max(URL_MAX)
  .refine((v) => v === "" || isWebUrl(v), {
    message: "Give an http or https URL",
  });

const listArgs = z.strictObject({ listId: id });
const itemArgs = z.strictObject({ itemId: id });

// Each op type and the schema of its `args`. Keep this order: OP_TYPES and
// the union use it.
const ARGS = {
  createList: z.strictObject({ listId: id, name: listName }),
  renameList: z.strictObject({ listId: id, name: listName }),
  deleteList: listArgs,
  restoreList: listArgs,
  addItem: z.strictObject({
    itemId: id,
    listId: id,
    name: itemName,
    quantity: quantity.default(1),
    notes: notes.default(""),
    url: url.default(""),
  }),
  updateItem: z.strictObject({
    itemId: id,
    fields: z
      .strictObject({ name: itemName, quantity, notes, url })
      .partial()
      .refine((f) => Object.keys(f).length > 0, {
        message: "Give at least one field",
      }),
  }),
  check: itemArgs,
  uncheck: itemArgs,
  deleteItem: itemArgs,
  restoreItem: itemArgs,
  moveItem: z.strictObject({ itemId: id, toListId: id }),
  // These three change the items of the list that the server has when it
  // applies the op. #5 and #67 set the rules.
  clearChecked: listArgs,
  uncheckAll: listArgs,
  checkAll: listArgs,
  // The item was not in the store (#131). A check, a check all, and a move
  // to another list also mark it in stock.
  markOutOfStock: itemArgs,
  markInStock: itemArgs,
} as const;

export type OpType = keyof typeof ARGS;
export const OP_TYPES = Object.keys(ARGS) as OpType[];

const envelope = {
  /** A UUID. The server applies each opId one time only. */
  opId: id,
  /** The node of `hlc`. A device UUID, or a fixed ID for server writes. */
  clientId: z.string().regex(NODE_PATTERN),
  /** A serialized HLC (src/shared/hlc.ts). */
  hlc: z.string().refine(isHlc, { message: "Not a valid HLC" }),
};

function opSchemaFor<T extends OpType>(type: T) {
  return z.strictObject({
    ...envelope,
    type: z.literal(type),
    args: ARGS[type] as (typeof ARGS)[T],
  });
}

/** One schema for each op type. */
export const opSchemas = {
  createList: opSchemaFor("createList"),
  renameList: opSchemaFor("renameList"),
  deleteList: opSchemaFor("deleteList"),
  restoreList: opSchemaFor("restoreList"),
  addItem: opSchemaFor("addItem"),
  updateItem: opSchemaFor("updateItem"),
  check: opSchemaFor("check"),
  uncheck: opSchemaFor("uncheck"),
  deleteItem: opSchemaFor("deleteItem"),
  restoreItem: opSchemaFor("restoreItem"),
  moveItem: opSchemaFor("moveItem"),
  clearChecked: opSchemaFor("clearChecked"),
  uncheckAll: opSchemaFor("uncheckAll"),
  checkAll: opSchemaFor("checkAll"),
  markOutOfStock: opSchemaFor("markOutOfStock"),
  markInStock: opSchemaFor("markInStock"),
} satisfies { [T in OpType]: ReturnType<typeof opSchemaFor<T>> };

/**
 * Any op. The node of `hlc` must be the `clientId`, so that an op cannot use
 * the clock of a different device.
 */
export const opSchema = z
  .discriminatedUnion("type", Object.values(opSchemas) as OpSchemaTuple)
  // Zod runs this check also when a field check failed. Thus a bad HLC
  // passes here: the `hlc` check already gave an issue for it.
  .refine((op) => !isHlc(op.hlc) || parse(op.hlc).node === op.clientId, {
    message: "The HLC node must be the clientId",
    path: ["hlc"],
  });

type OpSchemaTuple = [
  (typeof opSchemas)[OpType],
  ...(typeof opSchemas)[OpType][],
];

/** An op after parse: trimmed strings and defaults set. */
export type Op = z.output<typeof opSchema>;
/** An op before parse, as a client makes it. */
export type OpInput = z.input<typeof opSchema>;
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;
export type OpArgs<T extends OpType> = OpOf<T>["args"];
