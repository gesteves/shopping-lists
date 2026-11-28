// Private lists (#154): only the creator sees the list and its items, and
// it sends no push.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { activity, items, lists, serverSeq } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { opSchema, type Op, type OpType } from "@/shared/ops";
import type { PresenceSnapshot } from "@/shared/presence";
import type { PushPayload } from "@/shared/push";
import type { PullResponse } from "@/shared/sync";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { readHistory } from "./history";
import { Notifier } from "./notify/worker";
import { applyOps, expireCheckedItems, type Actor } from "./ops";
import { presenceFor } from "./presence";
import { purgeTombstones } from "./purge";
import {
  readHiddenListIds,
  readListById,
  readLiveLists,
  searchLiveItems,
} from "./queries";
import { handlePull } from "./sync";

const NODE = "6f6f6f6f-0000-4000-8000-000000000000";
const GIFTS = "11111111-1111-4111-8111-111111111111";
const SHOP = "22222222-2222-4222-8222-222222222222";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP_ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: Db;
let now: number;
let counter = 0;

beforeEach(() => {
  db = createTestDb();
  now = 1_764_000_000_000;
});
afterEach(() => db.$client.close());

function op(type: OpType, args: Record<string, unknown>): Op {
  counter++;
  return opSchema.parse({
    opId: crypto.randomUUID(),
    clientId: NODE,
    hlc: serialize({ wall: now, counter: counter % 1000, node: NODE }),
    type,
    args,
  });
}

function act(actor: Actor, type: OpType, args: Record<string, unknown>) {
  now += 1000;
  const { results } = applyOps(actor, "app", [op(type, args)], {
    db,
    clock: new HlcClock("server", undefined, () => now),
    now: () => now,
  });
  return results[0];
}

/** Sam has a private list with one item, and a shared list. */
function seed() {
  act(SAM, "createList", { listId: GIFTS, name: "Gifts", private: true });
  act(SAM, "addItem", { itemId: ITEM, listId: GIFTS, name: "Lego" });
  act(SAM, "createList", { listId: SHOP, name: "Shop" });
  act(ALEX, "addItem", { itemId: SHOP_ITEM, listId: SHOP, name: "Milk" });
}

async function pull(userId: string, query = "?since=0") {
  const res = handlePull(
    new Request(`http://localhost/api/sync/pull${query}`),
    userId,
    { db, now: () => now, summaries: false },
  );
  return (await res.json()) as PullResponse;
}

function seqState() {
  return db.select().from(serverSeq).get()!;
}

describe("applyOps", () => {
  it("makes a private list, with its clock", () => {
    seed();
    const row = db.select().from(lists).where(eq(lists.id, GIFTS)).get()!;
    expect(row.private).toBe(true);
    expect(row.clocks.private).toBeDefined();
  });

  it("refuses each op of another user on a private list as not found", () => {
    seed();
    const list = { listId: GIFTS };
    const item = { itemId: ITEM };
    const cases: [OpType, Record<string, unknown>, string][] = [
      ["renameList", { ...list, name: "Mine" }, "list_not_found"],
      ["deleteList", list, "list_not_found"],
      ["restoreList", list, "list_not_found"],
      ["setListPrivate", { ...list, private: false }, "list_not_found"],
      [
        "addItem",
        { itemId: ITEM_2, listId: GIFTS, name: "Socks" },
        "list_not_found",
      ],
      ["updateItem", { ...item, fields: { quantity: 2 } }, "item_not_found"],
      ["check", item, "item_not_found"],
      ["uncheck", item, "item_not_found"],
      ["deleteItem", item, "item_not_found"],
      ["restoreItem", item, "item_not_found"],
      ["markOutOfStock", item, "item_not_found"],
      ["markInStock", item, "item_not_found"],
      ["moveItem", { ...item, toListId: SHOP }, "item_not_found"],
      ["moveItem", { itemId: SHOP_ITEM, toListId: GIFTS }, "list_not_found"],
      ["clearChecked", list, "list_not_found"],
      ["uncheckAll", list, "list_not_found"],
      ["checkAll", list, "list_not_found"],
    ];
    for (const [type, args, reason] of cases) {
      expect(act(ALEX, type, args), type).toMatchObject({
        status: "rejected",
        reason,
      });
    }
    const item1 = db.select().from(items).where(eq(items.id, ITEM)).get()!;
    expect(item1).toMatchObject({ quantity: 1, checked: false });
  });

  it("lets only the creator change the privacy", () => {
    seed();
    expect(
      act(ALEX, "setListPrivate", { listId: SHOP, private: true }),
    ).toMatchObject({ status: "rejected", reason: "not_owner" });
    expect(
      act(SAM, "setListPrivate", { listId: SHOP, private: true }),
    ).toMatchObject({ status: "applied", changed: true });
    expect(
      act(SAM, "setListPrivate", { listId: SHOP, private: true }),
    ).toMatchObject({ status: "applied", changed: false });
  });

  it("refuses a move between a private and a shared list", () => {
    seed();
    expect(
      act(SAM, "moveItem", { itemId: ITEM, toListId: SHOP }),
    ).toMatchObject({ status: "rejected", reason: "privacy_mismatch" });
    expect(
      act(SAM, "moveItem", { itemId: SHOP_ITEM, toListId: GIFTS }),
    ).toMatchObject({ status: "rejected", reason: "privacy_mismatch" });
  });

  it("raises purged_seq when a list becomes private, never lower", () => {
    seed();
    const before = seqState();
    act(SAM, "setListPrivate", { listId: SHOP, private: true });
    const after = seqState();
    expect(after.purgedSeq).toBe(after.value);
    expect(after.purgedSeq).toBeGreaterThan(before.purgedSeq);
  });

  it("gives each item a new seq when the list is shared", () => {
    seed();
    const old = db.select().from(items).where(eq(items.id, ITEM)).get()!.seq;
    const purged = seqState().purgedSeq;
    act(SAM, "setListPrivate", { listId: GIFTS, private: false });
    const row = db.select().from(items).where(eq(items.id, ITEM)).get()!;
    expect(row.seq).toBeGreaterThan(old);
    // A share makes no reset.
    expect(seqState().purgedSeq).toBe(purged);
  });

  it("sets private_to on the activity rows, and clears it on a share", () => {
    seed();
    const rowsOf = (listId: string) =>
      db
        .select({ privateTo: activity.privateTo })
        .from(activity)
        .where(eq(activity.listId, listId))
        .all()
        .map((r) => r.privateTo);
    expect(rowsOf(GIFTS)).toEqual([SAM.id, SAM.id]);
    expect(rowsOf(SHOP)).toEqual([null, null]);

    act(SAM, "setListPrivate", { listId: SHOP, private: true });
    expect(rowsOf(SHOP)).toEqual([SAM.id, SAM.id, SAM.id]);
    act(SAM, "setListPrivate", { listId: SHOP, private: false });
    expect(rowsOf(SHOP)).toEqual([null, null, null, null]);
  });

  it("gives the expiry rows of a private list private_to", () => {
    seed();
    act(SAM, "check", { itemId: ITEM });
    now += 31 * 86_400_000;
    expireCheckedItems({ db, now: () => now });
    const row = db
      .select()
      .from(activity)
      .where(eq(activity.type, "expireItem"))
      .get()!;
    expect(row.privateTo).toBe(SAM.id);
  });
});

describe("pull", () => {
  it("sends a private list and its items only to its creator", async () => {
    seed();
    const sam = await pull(SAM.id);
    expect(sam.lists.map((l) => l.id).sort()).toEqual([GIFTS, SHOP]);
    expect(sam.lists.find((l) => l.id === GIFTS)?.private).toBe(true);
    expect(sam.items.map((i) => i.id).sort()).toEqual([ITEM, SHOP_ITEM]);

    const alex = await pull(ALEX.id);
    expect(alex.lists.map((l) => l.id)).toEqual([SHOP]);
    expect(alex.items.map((i) => i.id)).toEqual([SHOP_ITEM]);
  });

  it("gives no empty page with hasMore across hidden rows", async () => {
    act(SAM, "createList", { listId: GIFTS, name: "Gifts", private: true });
    for (let i = 0; i < 5; i++) {
      act(SAM, "addItem", {
        itemId: crypto.randomUUID(),
        listId: GIFTS,
        name: `Gift ${i}`,
      });
    }
    act(SAM, "createList", { listId: SHOP, name: "Shop" });
    const page = await pull(ALEX.id, "?since=0&limit=1");
    expect(page.lists.map((l) => l.id)).toEqual([SHOP]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(seqState().value);
  });

  it("resets the other user when a list becomes private", async () => {
    seed();
    const first = await pull(ALEX.id);
    expect(first.lists.map((l) => l.id)).toEqual([SHOP]);
    act(SAM, "setListPrivate", { listId: SHOP, private: true });

    const next = await pull(
      ALEX.id,
      `?since=${first.cursor}&seen=${first.purgedSeq}`,
    );
    // The reset gives all the rows that Alex can see: none. The client
    // then deletes the rows that it has.
    expect(next).toMatchObject({ reset: true, lists: [], items: [] });
    const after = await pull(
      ALEX.id,
      `?since=${next.cursor}&seen=${next.purgedSeq}`,
    );
    expect(after.reset).toBe(false);
  });

  it("sends the items again when a list is shared", async () => {
    seed();
    const first = await pull(ALEX.id);
    act(SAM, "setListPrivate", { listId: GIFTS, private: false });
    const next = await pull(
      ALEX.id,
      `?since=${first.cursor}&seen=${first.purgedSeq}`,
    );
    expect(next.reset).toBe(false);
    expect(next.lists.map((l) => l.id)).toEqual([GIFTS]);
    expect(next.items.map((i) => i.id)).toEqual([ITEM]);
  });
});

describe("reads", () => {
  it("leaves out the private lists of other users", () => {
    seed();
    expect(readLiveLists(ALEX.id, db).map((l) => l.list.id)).toEqual([SHOP]);
    expect(
      readLiveLists(SAM.id, db)
        .map((l) => l.list.id)
        .sort(),
    ).toEqual([GIFTS, SHOP]);
    expect(readListById(GIFTS, ALEX.id, db)).toBeUndefined();
    expect(readListById(GIFTS, SAM.id, db)?.private).toBe(true);
    expect(searchLiveItems("lego", 50, ALEX.id, db)).toEqual([]);
    expect(searchLiveItems("lego", 50, SAM.id, db)).toHaveLength(1);
    expect([...readHiddenListIds(ALEX.id, db)]).toEqual([GIFTS]);
    expect([...readHiddenListIds(SAM.id, db)]).toEqual([]);
  });

  it("keeps the history private, also after the purge of the list", () => {
    seed();
    act(SAM, "deleteList", { listId: GIFTS });
    now += 31 * 86_400_000;
    purgeTombstones(30, { db, now: () => now });
    purgeTombstones(30, { db, now: () => now + 31 * 86_400_000 });
    expect(
      db.select().from(lists).where(eq(lists.id, GIFTS)).get(),
    ).toBeUndefined();

    const of = (userId: string) =>
      readHistory({ userId, listId: GIFTS, limit: 50 }, db);
    expect(of(ALEX.id)).toEqual([]);
    expect(of(SAM.id).length).toBeGreaterThan(0);
    expect(
      readHistory({ userId: ALEX.id, limit: 50 }, db).every(
        (r) => r.listId === SHOP,
      ),
    ).toBe(true);
  });
});

describe("presence", () => {
  it("hides the list and the item on a hidden list", () => {
    const snapshot: PresenceSnapshot = {
      entries: [
        { userId: SAM.id, clientId: "a", listId: GIFTS, editingItemId: ITEM },
        { userId: SAM.id, clientId: "b", listId: SHOP, editingItemId: null },
      ],
    };
    expect(presenceFor(snapshot, new Set([GIFTS])).entries).toEqual([
      { userId: SAM.id, clientId: "a", listId: null, editingItemId: null },
      { userId: SAM.id, clientId: "b", listId: SHOP, editingItemId: null },
    ]);
  });
});

describe("notifications", () => {
  let sent: { userId: string; payload: PushPayload }[];
  const notifier = () =>
    new Notifier({
      db,
      now: () => now,
      allowlist: `${SAM.email},${ALEX.email}`,
      send: async (userId, payload) => {
        sent.push({ userId, payload });
      },
      canPush: () => true,
    });
  const later = () => {
    now += 10 * 60_000;
  };
  beforeEach(() => {
    sent = [];
  });

  it("sends nothing for a private list", async () => {
    act(SAM, "createList", { listId: GIFTS, name: "Gifts", private: true });
    act(SAM, "addItem", { itemId: ITEM, listId: GIFTS, name: "Lego" });
    later();
    await notifier().tick();
    expect(sent).toEqual([]);
  });

  it("drops the rows from before a list became private", async () => {
    act(SAM, "createList", { listId: SHOP, name: "Shop" });
    act(SAM, "addItem", { itemId: ITEM, listId: SHOP, name: "Lego" });
    act(SAM, "setListPrivate", { listId: SHOP, private: true });
    later();
    await notifier().tick();
    expect(sent).toEqual([]);
  });

  it("sends a share, but not the changes from the private time", async () => {
    seed();
    later();
    await notifier().tick();
    sent = [];
    act(SAM, "setListPrivate", { listId: GIFTS, private: false });
    later();
    await notifier().tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].userId).toBe(ALEX.id);
    expect(sent[0].payload.body).toBe("Sam shared the “Gifts” list.");
  });

  it("sends nothing for a share and a make-private in one burst", async () => {
    seed();
    later();
    await notifier().tick();
    sent = [];
    act(SAM, "setListPrivate", { listId: GIFTS, private: false });
    act(SAM, "setListPrivate", { listId: GIFTS, private: true });
    later();
    await notifier().tick();
    expect(sent).toEqual([]);
  });
});
