import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";
import { serialize } from "../src/shared/hlc";

test("the sync routes need a session", async ({ request }) => {
  const push = await request.post("/api/sync/push", {
    data: { clientId: "x", ops: [] },
  });
  expect(push.status()).toBe(401);
  const pull = await request.get("/api/sync/pull?since=0");
  expect(pull.status()).toBe(401);
});

test("a signed-in client pushes ops and pulls them back", async ({ page }) => {
  const params = new URLSearchParams({ email: E2E_ALLOWED_EMAIL, name: "Ana" });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");

  const clientId = randomUUID();
  const listId = randomUUID();
  const hlc = (counter: number) =>
    serialize({ wall: Date.now(), counter, node: clientId });
  const ops = [
    {
      opId: randomUUID(),
      clientId,
      hlc: hlc(0),
      type: "createList",
      args: { listId, name: "E2E list" },
    },
    {
      opId: randomUUID(),
      clientId,
      hlc: hlc(1),
      type: "addItem",
      args: { itemId: randomUUID(), listId, name: "Milk" },
    },
  ];

  const push = await page.request.post("/api/sync/push", {
    data: { clientId, ops },
  });
  expect(push.status()).toBe(200);
  const pushed = await push.json();
  expect(pushed.results.map((r: { status: string }) => r.status)).toEqual([
    "applied",
    "applied",
  ]);

  // The same push again is safe.
  const again = await page.request.post("/api/sync/push", {
    data: { clientId, ops },
  });
  expect(
    (await again.json()).results.map((r: { status: string }) => r.status),
  ).toEqual(["duplicate", "duplicate"]);

  const pull = await page.request.get("/api/sync/pull?since=0");
  expect(pull.status()).toBe(200);
  expect(pull.headers()["cache-control"]).toBe("no-store");
  const body = await pull.json();
  expect(body.lists).toContainEqual(
    expect.objectContaining({ id: listId, name: "E2E list" }),
  );
  expect(body.items).toContainEqual(
    expect.objectContaining({ listId, name: "Milk" }),
  );
  expect(body.users).toContainEqual(expect.objectContaining({ name: "Ana" }));
  expect(body.cursor).toBeGreaterThanOrEqual(pushed.seq);
});
