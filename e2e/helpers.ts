import { expect, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";

/** Sign in through the stub, as Google would. */
export async function signIn(
  page: Page,
  email = E2E_ALLOWED_EMAIL,
  name = "Ana",
) {
  const params = new URLSearchParams({ email, name });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");
}

/** The number of ops in the local outbox (Dexie database "shopping-lists"). */
export function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("shopping-lists");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("outbox")) {
            db.close();
            return resolve(0);
          }
          const count = db.transaction("outbox").objectStore("outbox").count();
          count.onsuccess = () => {
            resolve(count.result);
            db.close();
          };
        };
      }),
  );
}

/** Wait until the server has every local change. */
export async function synced(page: Page) {
  await expect.poll(() => outboxCount(page), { timeout: 10_000 }).toBe(0);
}
