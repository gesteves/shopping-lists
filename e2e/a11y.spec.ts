// The accessibility pass (#20): an axe scan of each main screen, in light
// and dark, on each project (phone and desktop). Also the reduced motion
// setting, and the "Keep screen on" toggle.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn, synced } from "./helpers";

async function scan(page: Page, screen: string) {
  // Wait for the Web Awesome components: undefined tags are hidden.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("*")].every(
      (el) =>
        !el.localName.startsWith("wa-") || customElements.get(el.localName),
    ),
  );
  // Colors in the middle of a fade-in are not the real colors.
  // Web Awesome animates in its shadow roots, which document.getAnimations()
  // does not include.
  await page.waitForFunction(() =>
    [
      document,
      ...[...document.querySelectorAll("*")].flatMap((el) =>
        el.shadowRoot ? [el.shadowRoot] : [],
      ),
    ].every((root) =>
      root.getAnimations().every((a) => a.playState !== "running"),
    ),
  );
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target} (${n.any.map((c) => c.message).join("; ")})`)
          .join(" | ")}`,
    ),
    screen,
  ).toEqual([]);
}

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
      const index = page
        .getByRole("region", { name: "Lists" })
        .filter({ visible: true });
      await index.getByLabel("New list name").fill(name);
      await index.getByRole("button", { name: "Create" }).click();
      await index.getByRole("link", { name }).click();
      for (const item of ["Milk", "Eggs"]) {
        await page.getByLabel("Item name").fill(item);
        await page.getByRole("button", { name: "Add", exact: true }).click();
      }
      await page.getByRole("checkbox", { name: /^Eggs\b/ }).click();
      await synced(page);
      await scan(page, "list");

      await page.getByRole("button", { name: "Edit Milk" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
      await scan(page, "item sheet");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "List actions" }).click();
      await expect(
        page.getByRole("menuitem", { name: "Rename" }),
      ).toBeVisible();
      await scan(page, "list menu");
      await page.keyboard.press("Escape");

      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { name: "Settings" }),
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
    const index = page
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true });
    await index.getByLabel("New list name").fill(name);
    await index.getByRole("button", { name: "Create" }).click();
    await index.getByRole("link", { name }).click();
    await page.getByLabel("Item name").fill("Milk");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Edit Milk" }).click();
    // No transition: the sheet runs no animations.
    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((a) => a.playState === "running")
          .length,
    );
    expect(running).toBe(0);
  } finally {
    await context.close();
  }
});

test("Keep screen on holds the wake lock and is remembered", async ({
  page,
}) => {
  // A fake Wake Lock API: headless browsers have none.
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
  const wake = () =>
    page.evaluate(
      () => (window as unknown as { __wake: { held: number } }).__wake.held,
    );

  await signIn(page);
  const toggle = page.getByRole("button", { name: "Keep screen on" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(wake).toBe(1);

  // The setting is kept on this device.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Keep screen on" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect.poll(wake).toBe(1);

  await page.getByRole("button", { name: "Keep screen on" }).click();
  await expect.poll(wake).toBe(0);
});

test("Keep screen on is hidden without the Wake Lock API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", { value: undefined });
  });
  await signIn(page);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep screen on" }),
  ).toHaveCount(0);
});
