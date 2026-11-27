import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  createList,
  dialog,
  listAction,
  openList,
  signIn,
  synced,
} from "./helpers";

/** The visible list index: the page on a phone, the sidebar on a desktop. */
function lists(page: Page) {
  return page
    .getByRole("region", { name: copy.lists.heading })
    .filter({ visible: true });
}

test("create, rename, and delete a list, and keep them after a reload", async ({
  page,
}) => {
  await signIn(page);
  const name = `Store ${randomUUID().slice(0, 8)}`;
  const renamed = `${name} renamed`;

  // Create. The one test that clicks the button: the other tests use
  // createList(), which presses Enter.
  await lists(page).getByLabel(copy.lists.newName).fill(name);
  await lists(page).getByRole("button", { name: copy.lists.create }).click();
  const row = lists(page).getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText(copy.lists.nothingToGet);
  await synced(page);
  await page.reload();
  await expect(lists(page).getByRole("link", { name })).toBeVisible();

  // Rename.
  await listAction(page, name, copy.common.rename);
  const input = lists(page).getByLabel(copy.lists.renameLabel(name));
  await input.fill(renamed);
  await input.press("Enter");
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();
  await synced(page);
  await page.reload();
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();

  // Delete, after a confirmation.
  await listAction(page, renamed, copy.common.delete);
  const confirm = dialog(page, copy.lists.deleteTitle(renamed));
  await confirm.getByRole("button", { name: copy.common.cancel }).click();
  await expect(confirm).toBeHidden();
  // Wait for the end of the hide animation: an open during it does nothing.
  await expect(page.locator("wa-dialog[open]")).toHaveCount(0);
  await expect(lists(page).getByRole("link", { name: renamed })).toBeVisible();
  await listAction(page, renamed, copy.common.delete);
  await confirm.getByRole("button", { name: copy.lists.deleteConfirm }).click();
  await expect(lists(page).getByRole("link", { name: renamed })).toHaveCount(0);
  await synced(page);
  await page.reload();
  await expect(
    lists(page).getByRole("heading", { name: copy.lists.heading }),
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
    await createList(page, name);
    await openList(page, name);
    // The header is there on the list page too.
    await expect(
      page.getByRole("link", { name: copy.header.settings }),
    ).toBeVisible();
    const aside = page.getByRole("complementary", { name: copy.lists.sidebar });
    if (sidebar) await expect(aside).toBeVisible();
    else {
      await expect(aside).toBeHidden();
      await expect(
        page.getByRole("link", { name: copy.list.back, exact: true }),
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

    // Under heavy parallel load, a late navigation can interrupt this one.
    await expect(async () => {
      await page.goto("/");
    }).toPass();
    await expect(lists(page).getByRole("link", { name })).toBeVisible();
    const home = testInfo.outputPath(`home-${width}.png`);
    await page.screenshot({ path: home });
    await testInfo.attach(`home-${width}`, {
      path: home,
      contentType: "image/png",
    });
  });
}
