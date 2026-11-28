import { describe, expect, it } from "vitest";
import { serialize } from "./hlc";
import {
  ITEM_NAME_MAX,
  LIST_NAME_MAX,
  NOTES_MAX,
  OP_TYPES,
  QUANTITY_MAX,
  opSchema,
  opSchemas,
  type OpInput,
  type OpType,
} from "./ops";
import { URL_MAX } from "./url";

const CLIENT = "5b0c5c8e-4c1e-4f7a-9d55-2f0f1c4b9a10";
const OTHER = "0d3f6f2a-8b7e-4c1d-a2b9-6e5c4d3b2a19";
const LIST = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const LIST_2 = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const ITEM = "c0ffee00-1234-4abc-9def-0123456789ab";
const HLC = serialize({ wall: 1_764_000_000_000, counter: 0, node: CLIENT });

function op(type: OpType, args: unknown): unknown {
  return {
    opId: "7e57c0de-0000-4000-8000-000000000001",
    clientId: CLIENT,
    hlc: HLC,
    type,
    args,
  };
}

// One valid op for each type.
const VALID: Record<OpType, unknown> = {
  createList: { listId: LIST, name: "Whole Foods" },
  renameList: { listId: LIST, name: "Costco" },
  deleteList: { listId: LIST },
  restoreList: { listId: LIST },
  addItem: { itemId: ITEM, listId: LIST, name: "Milk" },
  updateItem: { itemId: ITEM, fields: { quantity: 2 } },
  check: { itemId: ITEM },
  uncheck: { itemId: ITEM },
  deleteItem: { itemId: ITEM },
  restoreItem: { itemId: ITEM },
  moveItem: { itemId: ITEM, toListId: LIST_2 },
  clearChecked: { listId: LIST },
  uncheckAll: { listId: LIST },
  checkAll: { listId: LIST },
  markOutOfStock: { itemId: ITEM },
  markInStock: { itemId: ITEM },
  setListPrivate: { listId: LIST, private: true },
};

// Bad args for each type.
const INVALID: Record<OpType, unknown[]> = {
  createList: [
    { listId: LIST },
    { listId: LIST, name: "   " },
    { listId: LIST, name: "x".repeat(LIST_NAME_MAX + 1) },
    { listId: "not-a-uuid", name: "Target" },
  ],
  renameList: [{ listId: LIST, name: "" }, { name: "Target" }],
  deleteList: [{}, { listId: 42 }],
  restoreList: [{ listId: "" }],
  addItem: [
    { listId: LIST, name: "Milk" },
    { itemId: ITEM, listId: LIST, name: "x".repeat(ITEM_NAME_MAX + 1) },
    { itemId: ITEM, listId: LIST, name: "Milk", quantity: 0 },
    { itemId: ITEM, listId: LIST, name: "Milk", quantity: 1.5 },
    { itemId: ITEM, listId: LIST, name: "Milk", quantity: QUANTITY_MAX + 1 },
    {
      itemId: ITEM,
      listId: LIST,
      name: "Milk",
      notes: "x".repeat(NOTES_MAX + 1),
    },
    { itemId: ITEM, listId: LIST, name: "Milk", url: "javascript:alert(1)" },
    { itemId: ITEM, listId: LIST, name: "Milk", url: "example.com" },
    { itemId: ITEM, listId: LIST, name: "Milk", checked: true },
  ],
  updateItem: [
    { itemId: ITEM, fields: {} },
    { itemId: ITEM, fields: { name: " " } },
    { itemId: ITEM, fields: { checked: true } },
    { itemId: ITEM, fields: { url: "ftp://example.com/milk" } },
    { itemId: ITEM, fields: { url: "data:text/html,hi" } },
    {
      itemId: ITEM,
      fields: { url: `https://example.com/${"x".repeat(URL_MAX)}` },
    },
    { itemId: ITEM },
  ],
  check: [{}, { itemId: ITEM, listId: LIST }],
  uncheck: [{ itemId: null }],
  deleteItem: [{ listId: LIST }],
  restoreItem: [{ itemId: "x" }],
  moveItem: [{ itemId: ITEM }, { itemId: ITEM, toListId: "x" }],
  clearChecked: [{ itemId: ITEM }],
  uncheckAll: [{}],
  checkAll: [{ listId: LIST, itemId: ITEM }],
  markOutOfStock: [{}, { itemId: ITEM, outOfStock: true }],
  markInStock: [{ listId: LIST }],
  setListPrivate: [{ listId: LIST }, { listId: LIST, private: "yes" }],
};

describe("op schemas", () => {
  it("cover every op type", () => {
    expect(Object.keys(VALID).sort()).toEqual([...OP_TYPES].sort());
    expect(Object.keys(opSchemas).sort()).toEqual([...OP_TYPES].sort());
    expect(OP_TYPES).toHaveLength(17);
  });

  for (const type of OP_TYPES) {
    describe(type, () => {
      it("accepts valid input", () => {
        const input = op(type, VALID[type]);
        expect(opSchema.safeParse(input).success).toBe(true);
        expect(opSchemas[type].safeParse(input).success).toBe(true);
      });

      it("rejects invalid args", () => {
        for (const args of INVALID[type]) {
          const result = opSchema.safeParse(op(type, args));
          expect(result.success, JSON.stringify(args)).toBe(false);
        }
      });

      it("rejects the args of a different type", () => {
        const other = type === "check" ? "createList" : "check";
        expect(opSchemas[type].safeParse(op(other, VALID[type])).success).toBe(
          false,
        );
      });
    });
  }
});

describe("op envelope", () => {
  const good = op("check", { itemId: ITEM }) as Record<string, unknown>;

  it("rejects a bad or missing envelope field", () => {
    for (const bad of [
      { ...good, opId: "1" },
      { ...good, opId: undefined },
      { ...good, clientId: "has space" },
      { ...good, hlc: "yesterday" },
      { ...good, type: "explode" },
      { ...good, extra: true },
    ]) {
      expect(opSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects an HLC from a different client", () => {
    const hlc = serialize({ wall: 1_764_000_000_000, counter: 0, node: OTHER });
    const result = opSchema.safeParse({ ...good, hlc });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["hlc"]);
  });

  it("accepts a fixed server client ID", () => {
    const hlc = serialize({ wall: 1, counter: 0, node: "server" });
    expect(
      opSchema.safeParse({ ...good, clientId: "server", hlc }).success,
    ).toBe(true);
  });
});

describe("op parse output", () => {
  it("trims names and sets the addItem defaults", () => {
    const input: OpInput = {
      opId: "7e57c0de-0000-4000-8000-000000000002",
      clientId: CLIENT,
      hlc: HLC,
      type: "addItem",
      args: { itemId: ITEM, listId: LIST, name: "  Eggs " },
    };
    const parsed = opSchema.parse(input);
    expect(parsed.type).toBe("addItem");
    if (parsed.type !== "addItem") return;
    expect(parsed.args).toEqual({
      itemId: ITEM,
      listId: LIST,
      name: "Eggs",
      quantity: 1,
      notes: "",
      url: "",
    });
  });

  it("keeps only the given updateItem fields", () => {
    const parsed = opSchema.parse(
      op("updateItem", { itemId: ITEM, fields: { notes: "" } }),
    );
    if (parsed.type !== "updateItem") throw new Error(parsed.type);
    expect(parsed.args.fields).toEqual({ notes: "" });
  });
});
