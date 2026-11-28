import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { lists, pushSubscriptions } from "@/db/schema";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { captureLogs } from "@/test/logs";
import {
  FAILING_DISABLE_MS,
  MAX_RETRY_AFTER_MS,
  canPushTo,
  getVapidConfig,
  retryAfterMs,
  listMutedListIds,
  listSubscriptions,
  removeSubscription,
  saveSubscription,
  sendToUser,
  setListMuted,
  setSubscriptionEnabled,
  PUSH_TIMEOUT_MS,
  type SendOptions,
} from "./push";
import { isPushEndpoint, subscribeSchema } from "@/shared/push";

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
  const sub = trySubscribe(userId, n, label);
  if (!sub) throw new Error("The endpoint belongs to another user");
  return sub;
}

function trySubscribe(userId: string, n: number, label: string | null = null) {
  return saveSubscription(
    userId,
    {
      endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
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
    const again = subscribe(SAM.id, 1, "Mac");
    expect(again.id).toBe(first.id);
    expect(again.enabled).toBe(true);
    expect(again.deviceLabel).toBe("Mac");
    expect(listSubscriptions(SAM.id, db)).toHaveLength(1);
  });

  it("does not move an endpoint of another user to the caller", () => {
    const first = subscribe(SAM.id, 1, "iPhone");
    expect(trySubscribe(ALEX.id, 1, "Mac")).toBeNull();
    expect(listSubscriptions(ALEX.id, db)).toEqual([]);
    expect(listSubscriptions(SAM.id, db)).toEqual([
      expect.objectContaining({ id: first.id, deviceLabel: "iPhone" }),
    ]);
  });
});

describe("push endpoints", () => {
  const keys = { p256dh: "p", auth: "a" };

  it("accepts the hosts of the browser push services", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
    ]) {
      expect(isPushEndpoint(endpoint), endpoint).toBe(true);
      expect(subscribeSchema().safeParse({ endpoint, keys }).success).toBe(
        true,
      );
    }
  });

  it("refuses any other host", () => {
    for (const endpoint of [
      "https://example.com/push",
      "https://fcm.googleapis.com.evil.test/x",
      "https://evilpush.apple.com/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest",
    ]) {
      expect(isPushEndpoint(endpoint), endpoint).toBe(false);
      expect(subscribeSchema().safeParse({ endpoint, keys }).success).toBe(
        false,
      );
    }
    // Only the e2e tests accept a loopback endpoint.
    expect(
      isPushEndpoint("https://127.0.0.1:1/x", { allowLoopback: true }),
    ).toBe(true);
  });

  it("accepts the JSON of a PushSubscription, and no other keys", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/x";
    const schema = subscribeSchema();
    expect(
      schema.safeParse({ endpoint, expirationTime: null, keys }).success,
    ).toBe(true);
    expect(schema.safeParse({ endpoint, keys, extra: 1 }).success).toBe(false);
  });
});

describe("list mutes", () => {
  it("mutes and unmutes a list, one time each", () => {
    db.insert(lists)
      .values({
        id: LIST,
        name: "Oasis",
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
        endpoint: "https://fcm.googleapis.com/fcm/send/1",
        body: JSON.stringify(payload),
        options: expect.objectContaining({
          vapidDetails: VAPID,
          TTL: 86400,
          timeout: PUSH_TIMEOUT_MS,
        }),
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
      "https://fcm.googleapis.com/fcm/send/2",
    ]);
  });

  const status = (statusCode: number, headers = {}) =>
    Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, headers });

  it("counts failures, and turns a device off after 7 days of them", async () => {
    const errors = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sub = subscribe(SAM.id, 1);
    let now = 1_764_000_000_000;
    const forbidden = (async () => {
      throw status(403);
    }) satisfies Send;
    const options = () => ({
      db,
      vapid: VAPID,
      send: forbidden,
      now: () => now,
    });
    const row = () => listSubscriptions(SAM.id, db)[0];
    const failures = () =>
      db
        .select({
          count: pushSubscriptions.failureCount,
          since: pushSubscriptions.failingSince,
        })
        .from(pushSubscriptions)
        .get();

    const start = now;
    expect(await sendToUser(SAM.id, payload, options())).toEqual({
      sent: 0,
      removed: 0,
      failed: 1,
    });
    now += FAILING_DISABLE_MS - 1;
    await sendToUser(SAM.id, payload, options());
    expect(failures()).toEqual({ count: 2, since: new Date(start) });
    expect(row()).toMatchObject({ enabled: true, notDelivering: false });

    now += 1;
    await sendToUser(SAM.id, payload, options());
    expect(failures()?.count).toBe(3);
    expect(row()).toMatchObject({ enabled: false, notDelivering: true });
    expect(canPushTo(SAM.id, { db, vapid: VAPID })).toBe(false);

    // On again: a new try, with no failures.
    setSubscriptionEnabled(SAM.id, sub.id, true, db);
    expect(failures()).toEqual({ count: 0, since: null });
    expect(row()).toMatchObject({ enabled: true, notDelivering: false });
    errors.mockRestore();
    vi.restoreAllMocks();
  });

  it("logs the device ID and the host, never the endpoint", async () => {
    const logs = captureLogs();
    const gone = subscribe(SAM.id, 1);
    const failing = subscribe(SAM.id, 2);
    const send = (async (sub: { endpoint: string }) => {
      throw status(sub.endpoint.endsWith("/1") ? 410 : 500);
    }) as unknown as Send;
    await sendToUser(SAM.id, payload, { db, vapid: VAPID, send });
    const lines = logs.lines.map((l) => l.replace(/ ms=\d+/, ""));
    expect(lines).toContain(
      `info [push] removed device=${gone.id} host=fcm.googleapis.com status=410`,
    );
    expect(lines).toContain(
      `warn [push] failed device=${failing.id} host=fcm.googleapis.com status=500 err=Error`,
    );
    expect(lines).toContain(
      `info [push] sent user=${SAM.id} devices=2 sent=0 removed=1 failed=1`,
    );
    expect(logs.text()).not.toContain("/fcm/send/");
    vi.restoreAllMocks();
  });

  it("clears the failures on a success", async () => {
    const errors = vi.spyOn(console, "warn").mockImplementation(() => {});
    subscribe(SAM.id, 1);
    let fail = true;
    const send = (async () => {
      if (fail) throw status(500);
      return ok;
    }) satisfies Send;
    await sendToUser(SAM.id, payload, { db, vapid: VAPID, send });
    fail = false;
    await sendToUser(SAM.id, payload, { db, vapid: VAPID, send });
    expect(
      db
        .select({
          count: pushSubscriptions.failureCount,
          since: pushSubscriptions.failingSince,
          last: pushSubscriptions.lastFailureAt,
        })
        .from(pushSubscriptions)
        .get(),
    ).toEqual({ count: 0, since: null, last: null });
    errors.mockRestore();
  });

  it("tries a 429 once more after a short Retry-After", async () => {
    subscribe(SAM.id, 1);
    const waits: number[] = [];
    let calls = 0;
    const result = await sendToUser(SAM.id, payload, {
      db,
      vapid: VAPID,
      wait: async (ms) => {
        waits.push(ms);
      },
      send: (async () => {
        calls++;
        if (calls === 1) throw status(429, { "retry-after": "2" });
        return ok;
      }) satisfies Send,
    });
    expect(result).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(waits).toEqual([2000]);
    expect(calls).toBe(2);
  });

  it("does not try a 429 again with a long or no Retry-After", async () => {
    const errors = vi.spyOn(console, "warn").mockImplementation(() => {});
    subscribe(SAM.id, 1);
    for (const headers of [{ "retry-after": "60" }, {}]) {
      let calls = 0;
      const result = await sendToUser(SAM.id, payload, {
        db,
        vapid: VAPID,
        wait: async () => {},
        send: (async () => {
          calls++;
          throw status(429, headers);
        }) satisfies Send,
      });
      expect(result.failed).toBe(1);
      expect(calls).toBe(1);
    }
    errors.mockRestore();
  });

  it("reads Retry-After as seconds or as a date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(status(429, { "retry-after": "3" }), now)).toBe(3000);
    expect(
      retryAfterMs(
        status(429, { "retry-after": "Thu, 01 Jan 2026 00:00:04 GMT" }),
        now,
      ),
    ).toBe(4000);
    expect(retryAfterMs(status(429, { "retry-after": "soon" }), now)).toBe(
      null,
    );
    expect(retryAfterMs(status(429), now)).toBeNull();
    expect(MAX_RETRY_AFTER_MS).toBeLessThan(10_000);
  });

  it("can push only with VAPID keys and an enabled device", () => {
    expect(canPushTo(SAM.id, { db, vapid: VAPID })).toBe(false);
    const sub = subscribe(SAM.id, 1);
    expect(canPushTo(SAM.id, { db, vapid: VAPID })).toBe(true);
    expect(canPushTo(SAM.id, { db, vapid: null })).toBe(false);
    setSubscriptionEnabled(SAM.id, sub.id, false, db);
    expect(canPushTo(SAM.id, { db, vapid: VAPID })).toBe(false);
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
