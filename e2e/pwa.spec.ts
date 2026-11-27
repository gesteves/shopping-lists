import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { serialize } from "../src/shared/hlc";
import {
  authorizePath,
  createList,
  escapeRegExp,
  listIndex,
  openList,
  outboxCount,
  registerClient,
  signIn,
  synced,
} from "./helpers";

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
  // A list that this device does not open online, as from the other person.
  const other = `Hiking ${randomUUID().slice(0, 8)}`;
  const otherId = await pushList(page, other);
  await expect(
    listIndex(page).getByRole("link", { name: other }),
  ).toBeVisible();
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

  // A list that this device did not open online: the list shell (#103).
  await page.goto(`/lists/${otherId}`);
  await expect(
    page.getByRole("heading", { level: 1, name: other }),
  ).toBeVisible();
  // A page that this device never opened gets the offline page.
  await page.goto("/settings");
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

/** Make a list through the sync API, as another device does. */
async function pushList(page: Page, name: string) {
  const clientId = randomUUID();
  const listId = randomUUID();
  const res = await page.request.post("/api/sync/push", {
    data: {
      clientId,
      ops: [
        {
          opId: randomUUID(),
          clientId,
          hlc: serialize({ wall: Date.now(), counter: 0, node: clientId }),
          type: "createList",
          args: { listId, name },
        },
      ],
    },
  });
  expect(res.status()).toBe(200);
  return listId;
}

/** The names of the lists in IndexedDB, and the page caches. */
function deviceState(page: Page) {
  return page.evaluate(async () => {
    const lists = await new Promise<string[]>((resolve, reject) => {
      const open = indexedDB.open("shopping-lists");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("lists")) {
          db.close();
          return resolve([]);
        }
        const all = db.transaction("lists").objectStore("lists").getAll();
        all.onsuccess = () => {
          resolve(all.result.map((l: { name: string }) => l.name));
          db.close();
        };
      };
    });
    const pages: string[] = [];
    for (const name of await caches.keys()) {
      if (name.includes("precache")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) pages.push(request.url);
    }
    return { lists, pages };
  });
}

test("sign-out leaves no data of the user on the device", async ({
  page,
  context,
}) => {
  await signIn(page);
  await controlled(page);
  const name = `Private ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  await synced(page);
  await page.reload();
  expect((await deviceState(page)).lists).toContain(name);

  await page.goto("/settings");
  await page.getByRole("button", { name: copy.settings.signOut }).click();
  await expect(page).toHaveURL("/sign-in");
  const after = await deviceState(page);
  expect(after.lists).toEqual([]);
  // The worker does not cache the sign-in page either (#117).
  expect(after.pages).toEqual([]);

  // Offline, the pages of the user are gone too.
  await context.setOffline(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: copy.offline.heading }),
  ).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
  await context.setOffline(false);
});

test("a cached page of the last user does not delete the outbox of the next user", async ({
  page,
  context,
}) => {
  // Ana opens Settings. The worker keeps the page, with her user ID.
  await signIn(page);
  await controlled(page);
  await page.goto("/settings");
  await page.reload();

  // Ben signs in on the same browser, with no sign-out, and makes a change
  // offline.
  await signIn(page, E2E_SECOND_EMAIL, "Ben");
  const name = `Ben ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await synced(page);
  await page.reload();
  await expect(listIndex(page).getByRole("link", { name })).toBeVisible();
  await context.setOffline(true);
  await openList(page, name);
  await page.getByLabel(copy.addBar.name).fill("Rope");
  await page.getByLabel(copy.addBar.name).press("Enter");
  await expect.poll(() => outboxCount(page)).toBe(1);

  // Offline, the cached Settings page of Ana starts. The session cannot show
  // the user, thus the data of Ben stays.
  await page.goto("/settings");
  await page.waitForTimeout(500);
  expect(await outboxCount(page)).toBe(1);

  // Online, a page of Ben syncs the change.
  await context.setOffline(false);
  await page.goto("/");
  await synced(page);
  const pull = await page.request.get("/api/sync/pull?since=0");
  expect((await pull.json()).items).toContainEqual(
    expect.objectContaining({ name: "Rope" }),
  );
});

/** The copy of a URL in the page cache of the worker, or null. */
function cachedPage(page: Page, url: string) {
  return page.evaluate(async (url) => {
    const cache = await caches.open("pages");
    const res = await cache.match(url, { ignoreVary: true });
    if (!res) return null;
    const { status, type, redirected } = res;
    return { status, type, redirected, body: await res.text() };
  }, url);
}

test("an expired session does not replace a cached list page (#117)", async ({
  page,
  context,
}) => {
  await signIn(page);
  await controlled(page);
  const name = `Picnic ${randomUUID().slice(0, 8)}`;
  const listId = await pushList(page, name);
  const heading = page.getByRole("heading", { level: 1, name });
  await page.goto(`/lists/${listId}`);
  await expect(heading).toBeVisible();
  await synced(page);
  // A load through the worker, so it saves the page.
  await page.reload();
  await expect(heading).toBeVisible();
  const listUrl = page.url();
  await expect
    .poll(async () => (await cachedPage(page, listUrl))?.status)
    .toBe(200);
  const cookies = await context.cookies();

  // No session cookie: src/proxy.ts sends a 307 to /sign-in. The worker
  // gets an opaque redirect with status 0.
  await context.clearCookies();
  await page.goto(listUrl);
  await expect(page).toHaveURL("/sign-in");
  // The worker writes the cache after the response.
  await page.waitForTimeout(1000);
  expect(await cachedPage(page, listUrl)).toMatchObject({ status: 200 });
  // A cookie with no session: the page gives 200, and redirects in the
  // stream.
  await context.addCookies(
    cookies.map((c) =>
      c.name.includes("session_token") ? { ...c, value: "gone.gone" } : c,
    ),
  );
  await page.goto(listUrl);
  await expect(page).toHaveURL("/sign-in");
  await page.waitForTimeout(1000);

  const cached = await cachedPage(page, listUrl);
  expect(cached).toMatchObject({
    status: 200,
    type: "basic",
    redirected: false,
  });
  expect(cached?.body).not.toContain("NEXT_REDIRECT");

  // Offline, the cached page opens the list.
  await context.setOffline(true);
  await page.goto(listUrl);
  await expect(heading).toBeVisible();
  await context.setOffline(false);
});

test("the worker does not cache the consent page or the OAuth metadata (#117)", async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page);
  await controlled(page);
  const { name, clientId } = await registerClient(request);
  await page.goto(authorizePath(clientId, baseURL!).path);
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  const heading = page.getByRole("heading", {
    name: copy.consent.heading(name),
  });
  await expect(heading).toBeVisible();
  await page.reload();
  await expect(heading).toBeVisible();
  await page.goto("/.well-known/oauth-authorization-server");
  await page.goto("/");
  await expect(listIndex(page)).toBeVisible();
  // The worker writes the cache after the response.
  await page.waitForTimeout(1000);

  const paths = (await deviceState(page)).pages.map(
    (url) => new URL(url).pathname,
  );
  expect(paths).toContain("/");
  expect(paths).not.toContain("/oauth/consent");
  expect(paths).not.toContain("/.well-known/oauth-authorization-server");
});
