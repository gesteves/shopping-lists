import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { activity, lists } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type OpInput } from "@/shared/ops";
import { SAM, createTestDb } from "@/test/db";
import { bus } from "../bus";
import { applyOps, setListSummary } from "../ops";
import type { SummaryItem } from "./summarize";
import {
  MAX_WAIT_MS,
  QUIET_MS,
  RETRY_MS,
  SummaryWorker,
  summaryKey,
} from "./worker";

const LIST = "11111111-1111-4111-8111-111111111111";
const NODE = "6f6f6f6f-0000-4000-8000-000000000000";

let db: Db;
let now: number;
let calls: { list: string; items: string[] }[];
let answer: string | null;
let counter = 0;

beforeEach(() => {
  db = createTestDb();
  now = 1_764_000_000_000;
  calls = [];
  answer = "Milk, eggs, and produce";
});
afterEach(() => db.$client.close());

function worker() {
  return new SummaryWorker({
    db,
    now: () => now,
    summarize: async (list, items) => {
      calls.push({ list, items: items.map((i) => i.name) });
      return answer;
    },
  });
}

function act(request: Omit<OpInput, "opId" | "clientId" | "hlc">) {
  counter++;
  const op = opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: NODE,
    hlc: serialize({ wall: now, counter: counter % 1000, node: NODE }),
    ...request,
  });
  applyOps(SAM, "app", [op], {
    db,
    clock: new HlcClock("server", undefined, () => now),
    now: () => now,
  });
}

function add(name: string): string {
  const itemId = crypto.randomUUID();
  act({
    type: "addItem",
    args: { itemId, listId: LIST, name },
  } as never);
  return itemId;
}

function list() {
  return db.select().from(lists).where(eq(lists.id, LIST)).get()!;
}

beforeEach(() => {
  act({ type: "createList", args: { listId: LIST, name: "Costco" } } as never);
});

/** Add four items, then let the worker see them. */
async function seed(w: SummaryWorker) {
  for (const name of ["Milk", "Eggs", "Bread", "Kale"]) add(name);
  await w.tick();
}

describe("SummaryWorker", () => {
  it("waits until the items are quiet for 60 s, then writes the summary", async () => {
    const w = worker();
    await seed(w);
    now += 30_000;
    add("Lemons");
    await w.tick();
    now += QUIET_MS - 1;
    await w.tick();
    expect(calls).toEqual([]);

    now += 1;
    await w.tick();
    expect(calls).toEqual([
      { list: "Costco", items: ["Bread", "Eggs", "Kale", "Lemons", "Milk"] },
    ]);
    expect(list().summary).toBe("Milk, eggs, and produce");

    // Nothing again while the items stay the same.
    now += QUIET_MS * 10;
    await w.tick();
    await w.tick();
    expect(calls).toHaveLength(1);
  });

  it("makes no summary for one unchecked item", async () => {
    const w = worker();
    add("Milk");
    const eggs = add("Eggs");
    act({ type: "check", args: { itemId: eggs } } as never);
    await w.tick();
    now += QUIET_MS * 10;
    await w.tick();
    expect(calls).toEqual([]);
  });

  it("makes a summary after 3 minutes, also if the items keep changing", async () => {
    const w = worker();
    await seed(w);
    for (let t = 0; t < MAX_WAIT_MS; t += 20_000) {
      now += 20_000;
      add(`Item ${t}`);
      await w.tick();
    }
    expect(calls).toHaveLength(1);
  });

  it("tries again after a failure, but not at once", async () => {
    answer = null;
    const w = worker();
    await seed(w);
    now += QUIET_MS;
    await w.tick();
    expect(calls).toHaveLength(1);
    expect(list().summary).toBeNull();

    answer = "Milk and more";
    now += RETRY_MS - 1;
    await w.tick();
    expect(calls).toHaveLength(1);
    now += 1;
    await w.tick();
    expect(calls).toHaveLength(2);
    expect(list().summary).toBe("Milk and more");
  });

  it("writes the summary with a seq and a poke, but no attribution or activity", async () => {
    const w = worker();
    await seed(w);
    const before = list();
    const activityRows = db.select().from(activity).all().length;
    const pokes: number[] = [];
    const onPoke = ({ seq }: { seq: number }) => pokes.push(seq);
    bus.on("poke", onPoke);
    try {
      now += QUIET_MS;
      await w.tick();
    } finally {
      bus.off("poke", onPoke);
    }
    const after = list();
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(pokes).toEqual([after.seq]);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toBe(before.updatedBy);
    expect(after.clocks).toEqual(before.clocks);
    expect(db.select().from(activity).all()).toHaveLength(activityRows);
  });
});

describe("setListSummary", () => {
  it("writes nothing to a deleted or missing list", () => {
    act({ type: "deleteList", args: { listId: LIST } } as never);
    expect(setListSummary(LIST, "x", "k", { db })).toBe(false);
    expect(setListSummary("missing", "x", "k", { db })).toBe(false);
    expect(list().summary).toBeNull();
  });
});

describe("summaryKey", () => {
  const milk: SummaryItem = { name: "Milk", quantity: 1 };
  const eggs: SummaryItem = { name: "Eggs", quantity: 12 };

  it("is the same for the same items in any order", () => {
    expect(summaryKey([milk, eggs])).toBe(summaryKey([eggs, milk]));
  });

  it("changes with a name or a quantity", () => {
    expect(summaryKey([milk, eggs])).not.toBe(
      summaryKey([milk, { ...eggs, quantity: 6 }]),
    );
    expect(summaryKey([milk])).not.toBe(summaryKey([eggs]));
  });
});
