// No personal data in the log (#147): run the main paths of the server
// with a list, an item, and people whose names and emails are marked, and
// check each log line. See "Logging" in docs/PLAN.md.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import { HlcClock, serialize } from "@/shared/hlc";
import { ALEX, SAM, createTestDb } from "@/test/db";
import { captureLogs } from "@/test/logs";
import { handleClientLog, resetClientLogLimits } from "./client-log";
import { Notifier, QUIET_MS } from "./notify/worker";
import { PresenceStore } from "./presence";
import { saveSubscription, sendToUser } from "./push";
import { SummaryWorker } from "./summary/worker";
import { handlePull, handlePush } from "./sync";

const CLIENT = "3c3c3c3c-0000-4000-8000-000000000000";
const LIST = "11111111-1111-4111-8111-111111111111";
const ITEM = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const NOW = 1_764_000_000_000;
/** Each name, note, and URL has this mark. */
const MARK = "ZQX";
const SAM_EMAIL = "zqx-sam@example.com";
const ALEX_EMAIL = "zqx-alex@example.com";

let db: Db;
let now = NOW;

beforeEach(() => {
  vi.stubEnv("LOG_LEVEL", "debug");
  db = createTestDb();
  db.update(users)
    .set({ name: `${MARK}Sam`, email: SAM_EMAIL })
    .where(eq(users.id, SAM.id))
    .run();
  db.update(users)
    .set({ name: `${MARK}Alex`, email: ALEX_EMAIL })
    .where(eq(users.id, ALEX.id))
    .run();
  now = NOW;
});

afterEach(() => {
  db.$client.close();
  resetClientLogLimits();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let counter = 0;
function op(type: string, args: Record<string, unknown>) {
  counter++;
  return {
    opId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    clientId: CLIENT,
    hlc: serialize({ wall: NOW - 1000, counter, node: CLIENT }),
    type,
    args,
  };
}

function json(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the log has no personal data", () => {
  it("in sync, push, notifications, summaries, presence, and client errors", async () => {
    const logs = captureLogs();
    const clock = new HlcClock("server", undefined, () => NOW);

    // Sync: a list and an item with a note and a URL, and a refused op.
    await handlePush(
      json("/api/sync/push", {
        clientId: CLIENT,
        ops: [
          op("createList", { listId: LIST, name: `${MARK} Gift Shop` }),
          op("addItem", {
            itemId: ITEM,
            listId: LIST,
            name: `${MARK} secret`,
            notes: `${MARK} note`,
            url: `https://${MARK.toLowerCase()}.test/item`,
          }),
          op("addItem", {
            itemId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
            listId: LIST,
            name: `${MARK} other`,
          }),
          op("createList", { listId: LIST, name: `${MARK} Again` }),
        ],
      }),
      { id: SAM.id },
      { db, clock, now: () => NOW },
    );
    handlePull(new Request("http://localhost/api/sync/pull?since=0"), ALEX.id, {
      db,
      now: () => NOW,
    });

    // Push: one device that works and one that fails.
    const vapid = {
      publicKey: "pub",
      privateKey: "priv",
      subject: "https://x.test",
    };
    saveSubscription(
      ALEX.id,
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/zqx-1",
        keys: { p256dh: "p", auth: "a" },
        deviceLabel: `${MARK} phone`,
      },
      db,
    );
    saveSubscription(
      ALEX.id,
      {
        endpoint: "https://web.push.apple.com/zqx-2",
        keys: { p256dh: "p", auth: "a" },
        deviceLabel: null,
      },
      db,
    );
    const send = async (target: { endpoint: string }) => {
      if (target.endpoint.includes("apple")) {
        throw Object.assign(new Error(`HTTP 403 for ${target.endpoint}`), {
          statusCode: 403,
        });
      }
      return { statusCode: 201, body: "", headers: {} };
    };

    // The notifier: the text from a fake Claude has the names.
    now = NOW + QUIET_MS;
    const notifier = new Notifier({
      db,
      now: () => now,
      canPush: () => true,
      allowlist: `${SAM_EMAIL},${ALEX_EMAIL}`,
      summarize: async () => `${MARK}Sam added ${MARK} secret.`,
      send: (userId, payload) =>
        sendToUser(userId, payload, { db, vapid, send: send as never }),
    });
    await notifier.tick();

    // The summary worker, with a fake Claude.
    const worker = new SummaryWorker({
      db,
      now: () => now,
      quietMs: 0,
      summarize: async () => `${MARK} summary`,
    });
    await worker.tick();
    await worker.tick();

    // Presence, and a browser error that quotes the item name.
    new PresenceStore({ emit: () => {} }).set(SAM.id, {
      clientId: CLIENT,
      listId: LIST,
      editingItemId: ITEM,
    });
    await handleClientLog(
      json("/api/client-log", {
        area: "add",
        name: "Error",
        msg: `Could not add “${MARK} secret”`,
        page: `/lists/${LIST}`,
      }),
      SAM.id,
    );

    // Each path wrote its lines.
    for (const prefix of [
      "info [sync] push",
      "info [sync] pull",
      "info [notify] burst",
      "info [push] sent",
      "warn [push] failed",
      "info [summary] done",
      "debug [presence] set",
      "warn [client] error",
    ]) {
      expect(logs.find(prefix), prefix).not.toHaveLength(0);
    }
    const text = logs.text();
    expect(text).not.toMatch(new RegExp(MARK, "i"));
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("/fcm/send/");
  });
});
