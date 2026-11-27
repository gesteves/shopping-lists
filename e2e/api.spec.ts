import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Each JSON route refuses a body that is not application/json, and a body
// with an unknown key (#100). The good bodies are in the other tests.
const ROUTES: {
  method: "POST" | "PUT" | "PATCH";
  path: string;
  body: object;
}[] = [
  {
    method: "POST",
    path: "/api/push/subscriptions",
    body: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      keys: { p256dh: "p", auth: "a" },
    },
  },
  {
    method: "PATCH",
    path: `/api/push/subscriptions/${randomUUID()}`,
    body: { enabled: true },
  },
  {
    method: "PUT",
    path: "/api/push/mutes",
    body: { listId: randomUUID(), muted: true },
  },
  {
    method: "POST",
    path: "/api/presence",
    body: { clientId: randomUUID(), listId: null, editingItemId: null },
  },
  { method: "POST", path: "/api/push/test", body: {} },
  {
    method: "POST",
    path: "/api/sync/push",
    body: { clientId: randomUUID(), ops: [] },
  },
];

test(
  "the JSON routes refuse other content types and unknown keys",
  { tag: "@once" },
  async ({ page }) => {
    await signIn(page);
    for (const { method, path, body } of ROUTES) {
      const text = await page.request.fetch(path, {
        method,
        headers: { "content-type": "text/plain" },
        data: JSON.stringify(body),
      });
      expect(text.status(), `${path} text/plain`).toBe(415);

      const extra = await page.request.fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ ...body, extra: 1 }),
      });
      expect(extra.status(), `${path} unknown key`).toBe(400);
    }
  },
);

test(
  "a push endpoint on an unknown host gets 400",
  { tag: "@once" },
  async ({ page }) => {
    await signIn(page);
    const res = await page.request.post("/api/push/subscriptions", {
      data: {
        endpoint: `https://example.com/push/${randomUUID()}`,
        keys: { p256dh: "p", auth: "a" },
      },
    });
    expect(res.status()).toBe(400);
  },
);
