import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";

async function signIn(page: Page) {
  const params = new URLSearchParams({ email: E2E_ALLOWED_EMAIL, name: "Ana" });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");
}

/** The visible list index: the page on a phone, the sidebar on a desktop. */
function lists(page: Page) {
  return page.getByRole("region", { name: "Lists" }).filter({ visible: true });
}

/** Wait until the server has every change. */
async function synced(page: Page) {
  await expect(page.getByText(/to sync/)).toHaveCount(0);
}

test("create, rename, and delete a list, and keep them after a reload", async ({
  page,
}) => {
  await signIn(page);
  const name = `Store ${randomUUID().slice(0, 8)}`;
  const renamed = `${name} renamed`;

  // Create.
  await lists(page).getByLabel("New list name").fill(name);
  await lists(page).getByRole("button", { name: "Create" }).click();
  const row = lists(page).getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Nothing to get");
  await synced(page);
  await page.reload();
  await expect(lists(page).getByRole("link", { name })).toBeVisible();

  // Rename.
  await lists(page)
    .getByRole("button", { name: `More for ${name}` })
    .click();
  await lists(page).getByRole("button", { name: "Rename" }).click();
  const input = lists(page).getByLabel(`New name for “${name}”`);
  await input.fill(renamed);
  await input.press("Enter");
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();
  await synced(page);
  await page.reload();
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();

  // Delete, after a confirmation.
  await lists(page)
    .getByRole("button", { name: `More for ${renamed}` })
    .click();
  await lists(page).getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", {
    name: `Delete the “${renamed}” list?`,
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();
  await lists(page).getByRole("button", { name: "Delete" }).click();
  await dialog.getByRole("button", { name: "Delete list" }).click();
  await expect(lists(page).getByRole("link", { name: renamed })).toHaveCount(0);
  await synced(page);
  await page.reload();
  await expect(
    lists(page).getByRole("heading", { name: "Lists" }),
  ).toBeVisible();
  await expect(lists(page).getByRole("link", { name: renamed })).toHaveCount(0);
});

for (const { width, height, sidebar } of [
  { width: 375, height: 740, sidebar: false },
  { width: 1280, height: 800, sidebar: true },
]) {
  test(`the layout works at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await signIn(page);
    const name = `Layout ${randomUUID().slice(0, 8)}`;
    await lists(page).getByLabel("New list name").fill(name);
    await lists(page).getByRole("button", { name: "Create" }).click();
    await lists(page).getByRole("link", { name }).click();

    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    // The header is there on the list page too.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    const aside = page.getByRole("complementary", { name: "All lists" });
    if (sidebar) await expect(aside).toBeVisible();
    else {
      await expect(aside).toBeHidden();
      await expect(
        page.getByRole("link", { name: "Lists", exact: true }),
      ).toBeVisible();
    }
    // Nothing is wider than the screen.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const shot = testInfo.outputPath(`list-${width}.png`);
    await page.screenshot({ path: shot });
    await testInfo.attach(`list-${width}`, {
      path: shot,
      contentType: "image/png",
    });

    await page.goto("/");
    await expect(lists(page).getByRole("link", { name })).toBeVisible();
    const home = testInfo.outputPath(`home-${width}.png`);
    await page.screenshot({ path: home });
    await testInfo.attach(`home-${width}`, {
      path: home,
      contentType: "image/png",
    });
  });
}
