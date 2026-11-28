// The app icon badge (#161). The service worker counts the pushes (unit
// tests: src/shared/badge.test.ts). These tests check that the app clears
// the badge. A fake Badging API counts the calls, thus the browser does
// not change the result.
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { signIn } from "./helpers";

// The fake counts the clears in sessionStorage: the count then stays
// across the redirect of the sign-out.
const CLEARS = "e2e.badgeClears";

interface BadgeWindow {
  pageVisibility: DocumentVisibilityState;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    const w = window as unknown as BadgeWindow;
    w.pageVisibility = "visible";
    Object.defineProperty(navigator, "setAppBadge", {
      configurable: true,
      value: async () => {},
    });
    Object.defineProperty(navigator, "clearAppBadge", {
      configurable: true,
      value: async () => {
        const n = Number(sessionStorage.getItem(key) ?? 0);
        sessionStorage.setItem(key, String(n + 1));
      },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => w.pageVisibility,
    });
  }, CLEARS);
});

function clears(page: Page) {
  return page.evaluate(
    (key) => Number(sessionStorage.getItem(key) ?? 0),
    CLEARS,
  );
}

async function setVisibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate((s) => {
    (window as unknown as BadgeWindow).pageVisibility = s;
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test(
  "the app clears the badge at the load and when it comes to the front",
  { tag: "@once" },
  async ({ page }) => {
    await signIn(page);
    await expect.poll(() => clears(page)).toBeGreaterThanOrEqual(1);
    const before = await clears(page);

    await setVisibility(page, "hidden");
    expect(await clears(page)).toBe(before);

    await setVisibility(page, "visible");
    await expect.poll(() => clears(page)).toBe(before + 1);
  },
);

test("sign-out clears the badge", { tag: "@once" }, async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: copy.header.settings }).click();
  await expect(page).toHaveURL("/settings");
  await expect.poll(() => clears(page)).toBeGreaterThanOrEqual(1);
  const before = await clears(page);
  await page.getByRole("button", { name: copy.settings.signOut }).click();
  // The sign-in page is not in the app layout: it does not clear.
  await expect(page).toHaveURL("/sign-in");
  expect(await clears(page)).toBe(before + 1);
});
