import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import { serialize } from "../src/shared/hlc";
import {
  createList,
  dialog,
  openList,
  outboxCount,
  signIn,
  synced,
} from "./helpers";

test(
  "the sync routes need a session",
  { tag: "@once" },
  async ({ request }) => {
    const push = await request.post("/api/sync/push", {
      data: { clientId: "x", ops: [] },
    });
    expect(push.status()).toBe(401);
    const pull = await request.get("/api/sync/pull?since=0");
    expect(pull.status()).toBe(401);
  },
);

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

test("the app pulls into IndexedDB after sign-in", async ({ page }) => {
  const pulled = page.waitForResponse(
    (res) => res.url().includes("/api/sync/pull") && res.status() === 200,
  );
  const params = new URLSearchParams({ email: E2E_ALLOWED_EMAIL, name: "Ana" });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await pulled;

  // Read the Dexie database directly.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<{ users: number; cursor: unknown }>((resolve, reject) => {
            const open = indexedDB.open("shopping-lists");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction(["users", "meta"]);
              const users = tx.objectStore("users").count();
              const cursor = tx.objectStore("meta").get("cursor");
              tx.oncomplete = () => {
                resolve({ users: users.result, cursor: cursor.result?.value });
                open.result.close();
              };
            };
          }),
      ),
    )
    .toMatchObject({ users: expect.any(Number), cursor: expect.any(Number) });
});

test.describe("sign-out", () => {
  // page.route does not see the requests that go through a service worker.
  test.use({ serviceWorkers: "block" });

  test("sign-out with a change that did not sync asks first (#115)", async ({
    page,
    context,
  }) => {
    await signIn(page);
    const name = `Sign-out ${randomUUID().slice(0, 8)}`;
    await createList(page, name);
    await openList(page, name);
    await synced(page);

    // The push fails, thus the new item stays in the outbox.
    await page.route("**/api/sync/push", (route) => route.abort());
    await page.getByLabel(copy.addBar.name).fill("Milk");
    await page
      .getByRole("button", { name: copy.addBar.add, exact: true })
      .click();
    await expect.poll(() => outboxCount(page)).toBe(1);
    await page.getByRole("link", { name: copy.header.settings }).click();
    const signOut = page.getByRole("button", { name: copy.settings.signOut });
    await expect(signOut).toBeVisible();

    // Offline: no sync. The dialog asks, and Cancel keeps everything.
    await context.setOffline(true);
    await signOut.click();
    const confirm = dialog(page, copy.settings.signOutPendingTitle);
    await expect(confirm).toContainText(copy.settings.signOutPendingBody(1));
    await confirm.getByRole("button", { name: copy.common.cancel }).click();
    await expect(confirm).toBeHidden();
    // Wait for the end of the hide animation: an open during it does nothing.
    await expect(page.locator("wa-dialog[open]")).toHaveCount(0);
    await expect(page).toHaveURL("/settings");
    expect(await outboxCount(page)).toBe(1);

    // Online, but the last sync fails: it asks again. Sign out deletes it.
    await context.setOffline(false);
    await signOut.click();
    await expect(confirm).toContainText(copy.settings.signOutPendingBody(1));
    await confirm.getByRole("button", { name: copy.settings.signOut }).click();
    await expect(page).toHaveURL("/sign-in");
    expect(await outboxCount(page)).toBe(0);
  });
});
