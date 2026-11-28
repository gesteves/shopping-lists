import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type OpInput } from "@/shared/ops";
import { SAM, createTestDb } from "@/test/db";
import { historyAction, readHistory } from "./history";
import { applyOps } from "./ops";

const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NODE = "6f6f6f6f-0000-4000-8000-000000000000";
const NOW = 1_764_000_000_000;

let db: Db;
let wall = NOW - 60_000;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.$client.close());

function act(request: Omit<OpInput, "opId" | "clientId" | "hlc">) {
  wall += 1_000;
  const op = opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: NODE,
    hlc: serialize({ wall, counter: 0, node: NODE }),
    ...request,
  });
  applyOps(SAM, "app", [op], {
    db,
    clock: new HlcClock("server", undefined, () => NOW),
    now: () => NOW,
  });
}

const actions = (rows: ReturnType<typeof readHistory>) =>
  rows.map((r) => historyAction(r.type, r.snapshot));

describe("readHistory (#152)", () => {
  beforeEach(() => {
    act({
      type: "createList",
      args: { listId: LIST, name: "JojaMart" },
    } as never);
    act({
      type: "addItem",
      args: { itemId: ITEM, listId: LIST, name: "Milk" },
    } as never);
    act({ type: "check", args: { itemId: ITEM } } as never);
    // The name is on the list and checked: the add only unchecks it.
    act({
      type: "addItem",
      args: { itemId: ITEM_2, listId: LIST, name: "milk" },
    } as never);
  });

  it("calls an add of a checked name an uncheck", () => {
    expect(actions(readHistory({ userId: SAM.id, limit: 10 }, db))).toEqual([
      "unchecked",
      "checked",
      "added",
      "list_created",
    ]);
  });

  it("filters added and unchecked apart", () => {
    expect(
      actions(
        readHistory({ userId: SAM.id, actions: ["added"], limit: 10 }, db),
      ),
    ).toEqual(["added"]);
    expect(
      actions(
        readHistory({ userId: SAM.id, actions: ["unchecked"], limit: 10 }, db),
      ),
    ).toEqual(["unchecked"]);
    expect(
      actions(
        readHistory(
          { userId: SAM.id, actions: ["added", "unchecked"], limit: 10 },
          db,
        ),
      ),
    ).toEqual(["unchecked", "added"]);
  });

  it("orders by the op time, not by the time the server got it", () => {
    // All rows came at NOW. The op times are one second apart.
    const rows = readHistory({ userId: SAM.id, limit: 10 }, db);
    const times = rows.map((r) => r.opAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(rows.map((r) => r.at.getTime()))).toEqual(new Set([NOW]));
  });
});
