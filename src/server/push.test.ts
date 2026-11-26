import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { lists } from "@/db/schema";
import { ALEX, SAM, createTestDb } from "@/test/db";
import {
  getVapidConfig,
  listMutedListIds,
  listSubscriptions,
  removeSubscription,
  saveSubscription,
  sendToUser,
  setListMuted,
  setSubscriptionEnabled,
  type SendOptions,
} from "./push";

type Send = NonNullable<SendOptions["send"]>;
const ok = { statusCode: 201, body: "", headers: {} };

const VAPID = {
  publicKey: "pub",
  privateKey: "priv",
  subject: "https://x.test",
};
const LIST = "11111111-1111-4111-8111-111111111111";
let db: Db;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => db.$client.close());

function subscribe(userId: string, n: number, label: string | null = null) {
  return saveSubscription(
    userId,
    {
      endpoint: `https://push.test/${n}`,
      keys: { p256dh: `p${n}`, auth: `a${n}` },
      deviceLabel: label,
    },
    db,
  );
}

describe("getVapidConfig", () => {
  it("reads the keys, and uses the app origin as the subject", () => {
    expect(
      getVapidConfig({
        VAPID_PUBLIC_KEY: "pub",
        VAPID_PRIVATE_KEY: "priv",
        BETTER_AUTH_URL: "https://lists.example/app",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "https://lists.example",
    });
  });

  it("gives null when push is not set up", () => {
    expect(getVapidConfig({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("subscriptions", () => {
  it("saves, lists, turns off, turns on, and removes a device", () => {
    const sub = subscribe(SAM.id, 1, "iPhone · Safari");
    expect(listSubscriptions(SAM.id, db)).toEqual([
      expect.objectContaining({
        id: sub.id,
        deviceLabel: "iPhone · Safari",
        enabled: true,
      }),
    ]);
    expect(setSubscriptionEnabled(SAM.id, sub.id, false, db)).toBe(true);
    expect(listSubscriptions(SAM.id, db)[0].enabled).toBe(false);
    expect(setSubscriptionEnabled(SAM.id, sub.id, true, db)).toBe(true);
    expect(removeSubscription(SAM.id, sub.id, db)).toBe(true);
    expect(listSubscriptions(SAM.id, db)).toEqual([]);
  });

  it("lets a user change only their own devices", () => {
    const sub = subscribe(SAM.id, 1);
    expect(setSubscriptionEnabled(ALEX.id, sub.id, false, db)).toBe(false);
    expect(removeSubscription(ALEX.id, sub.id, db)).toBe(false);
    expect(listSubscriptions(SAM.id, db)).toHaveLength(1);
  });

  it("replaces the row when the same browser subscribes again", () => {
    const first = subscribe(SAM.id, 1);
    setSubscriptionEnabled(SAM.id, first.id, false, db);
    const again = subscribe(ALEX.id, 1, "Mac");
    expect(again.id).toBe(first.id);
    expect(again.enabled).toBe(true);
    expect(listSubscriptions(SAM.id, db)).toEqual([]);
    expect(listSubscriptions(ALEX.id, db)).toHaveLength(1);
  });
});

describe("list mutes", () => {
  it("mutes and unmutes a list, one time each", () => {
    db.insert(lists)
      .values({
        id: LIST,
        name: "Target",
        createdBy: SAM.id,
        createdAt: new Date(),
        updatedBy: SAM.id,
        updatedAt: new Date(),
        seq: 1,
      })
      .run();
    setListMuted(SAM.id, LIST, true, db);
    setListMuted(SAM.id, LIST, true, db);
    expect(listMutedListIds(SAM.id, db)).toEqual([LIST]);
    expect(listMutedListIds(ALEX.id, db)).toEqual([]);
    setListMuted(SAM.id, LIST, false, db);
    expect(listMutedListIds(SAM.id, db)).toEqual([]);
  });
});

describe("sendToUser", () => {
  const payload = { title: "T", body: "B", url: "/lists/x", tag: LIST };

  it("sends to each enabled device, and records the success", async () => {
    const on = subscribe(SAM.id, 1);
    const off = subscribe(SAM.id, 2);
    subscribe(ALEX.id, 3);
    setSubscriptionEnabled(SAM.id, off.id, false, db);
    const calls: { endpoint: string; body: string; options: unknown }[] = [];

    const result = await sendToUser(SAM.id, payload, {
      db,
      vapid: VAPID,
      send: (async (sub, body, options) => {
        calls.push({ endpoint: sub.endpoint, body: String(body), options });
        return ok;
      }) satisfies Send,
    });

    expect(result).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(calls).toEqual([
      {
        endpoint: "https://push.test/1",
        body: JSON.stringify(payload),
        options: expect.objectContaining({ vapidDetails: VAPID, TTL: 86400 }),
      },
    ]);
    expect(
      listSubscriptions(SAM.id, db).find((s) => s.id === on.id)?.lastSuccessAt,
    ).not.toBeNull();
  });

  it("deletes a device that the push service no longer knows", async () => {
    subscribe(SAM.id, 1);
    subscribe(SAM.id, 2);
    const result = await sendToUser(SAM.id, payload, {
      db,
      vapid: VAPID,
      send: (async (sub) => {
        if (sub.endpoint.endsWith("/1"))
          throw Object.assign(new Error("Gone"), { statusCode: 410 });
        throw Object.assign(new Error("Server"), { statusCode: 500 });
      }) satisfies Send,
    });
    expect(result).toEqual({ sent: 0, removed: 1, failed: 1 });
    expect(listSubscriptions(SAM.id, db).map((s) => s.endpoint)).toEqual([
      "https://push.test/2",
    ]);
  });

  it("sends nothing when push is not set up", async () => {
    subscribe(SAM.id, 1);
    const result = await sendToUser(SAM.id, payload, {
      db,
      vapid: null,
      send: (() => {
        throw new Error("no");
      }) satisfies Send,
    });
    expect(result).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
});
