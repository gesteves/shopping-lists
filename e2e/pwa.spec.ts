import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { createList, escapeRegExp, openList, signIn, synced } from "./helpers";

/** Wait until the service worker controls the page. */
async function controlled(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
}

test(
  "the service worker file needs no session and is not cached",
  { tag: "@once" },
  async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-cache");
    expect(res.headers()["content-type"]).toContain("javascript");
    expect(await res.text()).toContain("/~offline");
  },
);

test(
  "the manifest has what an install needs",
  { tag: "@once" },
  async ({ request }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({
      name: copy.app.name,
      short_name: copy.app.shortName,
      start_url: "/",
      display: "standalone",
    });
    const sizes = (purpose: string) =>
      manifest.icons
        .filter((i: { purpose?: string }) => (i.purpose ?? "any") === purpose)
        .map((i: { sizes: string }) => i.sizes);
    expect(sizes("any")).toEqual(
      expect.arrayContaining(["192x192", "512x512"]),
    );
    expect(sizes("maskable")).toContain("512x512");
    for (const icon of manifest.icons) {
      expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    }
  },
);

test("Chrome finds no installability errors", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The check uses the Chrome protocol.");
  await signIn(page);
  await controlled(page);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send(
    "Page.getInstallabilityErrors",
  );
  expect(installabilityErrors).toEqual([]);
});

test("the app opens offline, takes a change, and syncs it online", async ({
  page,
  context,
}) => {
  await signIn(page);
  await controlled(page);

  const name = `Camping ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  const listUrl = page.url();
  await synced(page);
  // A load through the worker, so it saves the page.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: new RegExp(`^${escapeRegExp(copy.sync.offline)}`) }),
  ).toBeVisible();

  await page.getByLabel(copy.addBar.name).fill("Candles");
  await page.getByLabel(copy.addBar.name).press("Enter");
  await expect(page.getByRole("checkbox", { name: /^Candles/ })).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: copy.sync.offlineWithChanges(1) }),
  ).toBeVisible();

  // A page that this device never opened gets the offline page.
  await page.goto("/lists/00000000-0000-4000-8000-000000000000");
  await expect(
    page.getByRole("heading", { name: copy.offline.heading }),
  ).toBeVisible();

  await context.setOffline(false);
  await page.goto(listUrl);
  await synced(page);
  const pull = await page.request.get("/api/sync/pull?since=0");
  const body = await pull.json();
  expect(body.items).toContainEqual(
    expect.objectContaining({ name: "Candles" }),
  );
});
