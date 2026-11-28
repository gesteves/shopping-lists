import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL, E2E_SECOND_EMAIL } from "../playwright.config";
import { serialize } from "../src/shared/hlc";

async function signIn(page: Page, email: string, name: string) {
  const params = new URLSearchParams({ email, name });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");
}

/** The names of the lists in the local Dexie database of `page`. */
function localListNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
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
      }),
  );
}

test("a change from one person shows up for the other at once", async ({
  browser,
}, testInfo) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a, E2E_ALLOWED_EMAIL, "Ana");
    const stream = b.waitForResponse((res) =>
      res.url().includes("/api/events"),
    );
    const firstPull = b.waitForResponse((res) =>
      res.url().includes("/api/sync/pull"),
    );
    await signIn(b, E2E_SECOND_EMAIL, "Ben");
    const events = await stream;
    await firstPull;
    expect(events.status()).toBe(200);
    expect(events.headers()["content-type"]).toContain("text/event-stream");
    // Not gzip: compression can hold the events in a buffer.
    expect(events.headers()["content-encoding"]).toBeUndefined();

    // A creates a list through the sync API, as the app does.
    const clientId = randomUUID();
    let counter = 0;
    async function createList() {
      const name = `Realtime ${testInfo.project.name} ${randomUUID().slice(0, 8)}`;
      const push = await a.request.post("/api/sync/push", {
        data: {
          clientId,
          ops: [
            {
              opId: randomUUID(),
              clientId,
              hlc: serialize({
                wall: Date.now(),
                counter: counter++,
                node: clientId,
              }),
              type: "createList",
              args: { listId: randomUUID(), name },
            },
          ],
        },
      });
      expect(push.status()).toBe(200);
      return name;
    }

    // First, B finishes its first sync. All the e2e tests use the same
    // lists, thus on a slow CI machine the first sync can take more than
    // the time of the check below.
    const first = await createList();
    await expect
      .poll(() => localListNames(b), { timeout: 15_000 })
      .toContain(first);

    // B gets a poke, syncs, and has the list. No reload.
    const name = await createList();
    await expect
      .poll(() => localListNames(b), { timeout: 2000, intervals: [100] })
      .toContain(name);
  } finally {
    await a.close();
    await b.close();
  }
});
