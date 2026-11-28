// The accessibility pass (#20): an axe scan of each main screen, in light
// and dark, on each project (phone and desktop). Also the reduced motion
// setting, and the "Keep screen on" toggle.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  createList,
  openList,
  scan,
  signIn,
  switchControl,
  synced,
  itemAction,
} from "./helpers";

for (const colorScheme of ["light", "dark"] as const) {
  test(`the main screens pass axe (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({
      ...testInfo.project.use,
      colorScheme,
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      await scan(page, "home");

      const name = `A11y ${randomUUID().slice(0, 8)}`;
      // A second list: the Move and Copy dialogs need one.
      await createList(page, `A11y other ${randomUUID().slice(0, 8)}`);
      await createList(page, name);
      await openList(page, name);
      for (const item of ["Milk", "Eggs"]) {
        await page.getByLabel(copy.addBar.name).fill(item);
        await page
          .getByRole("button", { name: copy.addBar.add, exact: true })
          .click();
      }
      await page.getByRole("checkbox", { name: /^Eggs\b/ }).click();
      await synced(page);
      await scan(page, "list");

      await itemAction(page, "Milk", copy.item.edit);
      await expect(
        page.getByLabel(copy.itemSheet.name, { exact: true }),
      ).toBeVisible();
      await scan(page, "item sheet");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: copy.list.actions }).click();
      await expect(
        page.getByRole("menuitem", { name: copy.common.rename }),
      ).toBeVisible();
      await scan(page, "list menu");
      await page.keyboard.press("Escape");

      // The item menu, the out-of-stock badge and toast, and the dialogs
      // (#131).
      await page
        .getByRole("button", { name: copy.item.more("Milk"), exact: true })
        .click();
      await expect(
        page.getByRole("menuitem", { name: copy.item.outOfStock }),
      ).toBeVisible();
      await scan(page, "item menu");
      await page.getByRole("menuitem", { name: copy.item.outOfStock }).click();
      await expect(
        page.getByRole("checkbox", { name: /^Milk\b/ }),
      ).toContainText(copy.item.outOfStock);
      await expect(
        page.locator("wa-toast-item", {
          hasText: copy.item.markedOutOfStock("Milk"),
        }),
      ).toBeVisible();
      await scan(page, "out of stock");
      for (const [action, title] of [
        [copy.item.move, copy.item.moveTitle("Milk")],
        [copy.item.copy, copy.item.copyTitle("Milk")],
      ] as const) {
        await itemAction(page, "Milk", action);
        await expect(page.getByRole("dialog", { name: title })).toBeVisible();
        await scan(page, `${action} dialog`);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: title })).toBeHidden();
      }

      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { name: copy.settings.title }),
      ).toBeVisible();
      await scan(page, "settings");

      await page.goto("/~offline");
      await scan(page, "offline");
    } finally {
      await context.close();
    }
  });
}

test("the item sheet opens at once with reduced motion", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    ...testInfo.project.use,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await signIn(page);
    const name = `Motion ${randomUUID().slice(0, 8)}`;
    await createList(page, name);
    await openList(page, name);
    await page.getByLabel(copy.addBar.name).fill("Milk");
    await page
      .getByRole("button", { name: copy.addBar.add, exact: true })
      .click();
    await itemAction(page, "Milk", copy.item.edit);
    // The sheet opens after the item menu closes (#131): wait for it.
    await expect(
      page.getByLabel(copy.itemSheet.name, { exact: true }),
    ).toBeVisible();
    // No transition: the sheet runs no animations. The items of the menu
    // have a short hover transition: they do not count.
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              !(
                (a.effect as KeyframeEffect | null)?.target as Element | null
              )?.closest("wa-dropdown"),
          ).length,
    );
    expect(running).toBe(0);
  } finally {
    await context.close();
  }
});

/** A fake Wake Lock API: headless browsers have none. Gives the lock count. */
async function fakeWakeLock(page: Page) {
  await page.addInitScript(() => {
    const state = { held: 0, requests: 0 };
    (window as unknown as { __wake: typeof state }).__wake = state;
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        async request() {
          state.requests++;
          state.held++;
          const listeners: (() => void)[] = [];
          const sentinel = {
            released: false,
            async release() {
              if (sentinel.released) return;
              sentinel.released = true;
              state.held--;
              listeners.forEach((l) => l());
            },
            addEventListener: (_: string, l: () => void) => listeners.push(l),
          };
          return sentinel;
        },
      },
    });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __wake: { held: number } }).__wake.held,
    );
}

test("Keep screen on holds the wake lock and is remembered", async ({
  page,
}) => {
  const wake = await fakeWakeLock(page);

  await signIn(page);
  await page.goto("/settings");
  const setting = page.getByRole("switch", {
    name: copy.settings.keepScreenOn,
  });
  // The control itself: the middle of the host is the hint text.
  const screenSwitch = switchControl(page, copy.settings.keepScreenOn).locator(
    '[part~="control"]',
  );
  await expect(setting).not.toBeChecked();
  // A click before hydration ends is lost: try again until it is on.
  await expect(async () => {
    await screenSwitch.click();
    await expect(setting).toBeChecked({ timeout: 1_000 });
  }).toPass();
  await expect.poll(wake).toBe(1);

  // The lock stays on other pages, and after a reload (kept on the device).
  await page.goto("/");
  await expect.poll(wake).toBe(1);
  await page.goto("/settings");
  await expect(setting).toBeChecked();
  await expect.poll(wake).toBe(1);

  await screenSwitch.click();
  await expect(setting).not.toBeChecked();
  await expect.poll(wake).toBe(0);
});

test("Keep screen on is hidden without the Wake Lock API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", { value: undefined });
  });
  await signIn(page);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: copy.settings.connectedApps }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: copy.settings.keepScreenOn }),
  ).toHaveCount(0);
});

test("Keep screen on is on the list page too", async ({ page }) => {
  const wake = await fakeWakeLock(page);
  await signIn(page);
  const name = `Screen ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);

  const setting = page.getByRole("switch", {
    name: copy.settings.keepScreenOn,
  });
  const screenSwitch = switchControl(page, copy.settings.keepScreenOn).locator(
    '[part~="control"]',
  );
  await expect(setting).not.toBeChecked();
  await expect(async () => {
    await screenSwitch.click();
    await expect(setting).toBeChecked({ timeout: 1_000 });
  }).toPass();
  await expect.poll(wake).toBe(1);

  // Settings shows the same setting. Wait for the page: the hidden list page
  // keeps its switch in the DOM.
  await page.getByRole("link", { name: copy.header.settings }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.settings.title }),
  ).toBeVisible();
  await expect(setting).toBeChecked();
  await screenSwitch.click();
  await expect(setting).not.toBeChecked();
  await expect.poll(wake).toBe(0);

  // Back on the list page, the switch shows the change.
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(setting).not.toBeChecked();
});
