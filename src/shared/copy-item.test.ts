import { describe, expect, it } from "vitest";
import type { ItemRecord } from "./sync";
import { copyPlan } from "./copy-item";

const FROM = "11111111-1111-4111-8111-111111111111";
const TO = "22222222-2222-4222-8222-222222222222";
const NEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function item(patch: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    listId: FROM,
    name: "Milk",
    quantity: 2,
    notes: "Oat",
    url: "https://example.com/oat-milk",
    checked: false,
    checkedAt: null,
    outOfStockAt: 1,
    createdBy: "u",
    createdAt: 1,
    updatedBy: "u",
    updatedAt: 1,
    updatedVia: "app",
    deletedAt: null,
    seq: 1,
    ...patch,
  };
}

describe("copyPlan", () => {
  it("adds the name, the quantity, the notes, and the URL to the target list", () => {
    expect(copyPlan(item(), TO, [], NEW)).toEqual({
      kind: "add",
      itemId: NEW,
      requests: [
        {
          type: "addItem",
          args: {
            itemId: NEW,
            listId: TO,
            name: "Milk",
            quantity: 2,
            notes: "Oat",
            url: "https://example.com/oat-milk",
          },
        },
      ],
    });
  });

  it("copies a row from an older server with no URL (#140)", () => {
    const old = item();
    delete (old as Partial<ItemRecord>).url;
    const [request] = copyPlan(old, TO, [], NEW).requests;
    expect(request).toMatchObject({ args: { url: "" } });
  });

  it("does nothing when the target has the name, unchecked", () => {
    const there = item({ id: "b", listId: TO, name: " MILK ", notes: "" });
    expect(copyPlan(item(), TO, [there], NEW)).toEqual({
      kind: "onList",
      itemId: "b",
      requests: [],
    });
  });

  it("unchecks a checked match, with the quantity, the notes, and the URL", () => {
    const there = item({
      id: "b",
      listId: TO,
      quantity: 1,
      notes: "",
      url: "",
      checked: true,
      checkedAt: 5,
    });
    expect(copyPlan(item(), TO, [there], NEW)).toEqual({
      kind: "uncheck",
      itemId: "b",
      requests: [
        { type: "uncheck", args: { itemId: "b" } },
        {
          type: "updateItem",
          args: {
            itemId: "b",
            fields: {
              quantity: 2,
              notes: "Oat",
              url: "https://example.com/oat-milk",
            },
          },
        },
      ],
    });
  });

  it("only unchecks when the fields are the defaults or the same", () => {
    const there = item({ id: "b", listId: TO, checked: true, checkedAt: 5 });
    expect(copyPlan(item(), TO, [there], NEW).requests).toEqual([
      { type: "uncheck", args: { itemId: "b" } },
    ]);
  });

  it("does not count a deleted item or an item on another list", () => {
    const deleted = item({ id: "b", listId: TO, deletedAt: 5 });
    const other = item({ id: "c" });
    expect(copyPlan(item(), TO, [deleted, other], NEW).kind).toBe("add");
  });
});
