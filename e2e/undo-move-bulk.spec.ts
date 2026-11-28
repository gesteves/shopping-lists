import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import {
  createList,
  dialog,
  listAction,
  listIndex,
  openList,
  pickList,
  signIn,
  synced,
  itemAction,
} from "./helpers";

async function add(page: Page, ...names: string[]) {
  for (const name of names) {
    await page.getByLabel(copy.addBar.name).fill(name);
    await page.getByLabel(copy.addBar.name).press("Enter");
  }
  for (const name of names) await expect(item(page, name)).toBeVisible();
}

function item(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

function toast(page: Page, text: string | RegExp) {
  return page.locator("wa-toast-item").filter({ hasText: text }).first();
}

test("delete then undo brings the item back for both people", async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a);
    await signIn(b, E2E_SECOND_EMAIL, "Haley");
    const name = `Undo ${randomUUID().slice(0, 8)}`;
    await createList(a, name);
    await openList(a, name);
    await add(a, "Lemons");
    await synced(a);
    await openList(b, name);
    await expect(item(b, "Lemons")).toBeVisible();

    await itemAction(a, "Lemons", copy.common.delete);
    await expect(item(a, "Lemons")).toHaveCount(0);
    await expect(item(b, "Lemons")).toHaveCount(0);

    await toast(a, copy.item.deleted("Lemons"))
      .getByRole("button", { name: copy.common.undo })
      .click();
    await expect(item(a, "Lemons")).toBeVisible();
    await expect(item(b, "Lemons")).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

test("delete a list, then undo", async ({ page }) => {
  await signIn(page);
  const name = `Undo list ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await listAction(page, name, copy.common.delete);
  await dialog(page, copy.lists.deleteTitle(name))
    .getByRole("button", { name: copy.lists.deleteConfirm })
    .click();
  await expect(listIndex(page).getByRole("link", { name })).toHaveCount(0);
  await toast(page, copy.lists.deleted(name))
    .getByRole("button", { name: copy.common.undo })
    .click();
  await expect(listIndex(page).getByRole("link", { name })).toBeVisible();
});

test("move an item to a different list", async ({ page }) => {
  await signIn(page);
  const from = `From ${randomUUID().slice(0, 8)}`;
  const to = `To ${randomUUID().slice(0, 8)}`;
  await createList(page, to);
  await createList(page, from);
  await openList(page, from);
  await add(page, "Tortillas");

  await itemAction(page, "Tortillas", copy.item.move);
  await pickList(page, "move", "Tortillas", to);
  await expect(item(page, "Tortillas")).toHaveCount(0);
  await expect(toast(page, copy.item.moved("Tortillas", to))).toBeVisible();
  await synced(page);

  await page.reload();
  await expect(item(page, "Tortillas")).toHaveCount(0);
  await page.goto("/");
  await openList(page, to);
  await expect(item(page, "Tortillas")).toBeVisible();
});

test("check all, uncheck all, and delete checked items, with undo", async ({
  page,
}) => {
  await signIn(page);
  const name = `Bulk ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  await add(page, "Rice", "Beans", "Salsa");
  await item(page, "Rice").click();
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "true");
  const menu = (label: string) =>
    page
      .getByRole("button", { name: copy.list.actions })
      .click()
      .then(() =>
        page.getByRole("menuitem", { name: label, exact: true }).click(),
      );

  // Check all, then undo: only the items that it checked go back.
  await menu(copy.list.checkAll);
  for (const n of ["Rice", "Beans", "Salsa"]) {
    await expect(item(page, n)).toHaveAttribute("aria-checked", "true");
  }
  await toast(page, copy.list.checkedAll(2))
    .getByRole("button", { name: copy.common.undo })
    .click();
  await expect(item(page, "Beans")).toHaveAttribute("aria-checked", "false");
  await expect(item(page, "Salsa")).toHaveAttribute("aria-checked", "false");
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "true");

  // Check all, and it syncs.
  await menu(copy.list.checkAll);
  await expect(item(page, "Salsa")).toHaveAttribute("aria-checked", "true");
  await synced(page);
  await page.reload();
  await expect(item(page, "Beans")).toHaveAttribute("aria-checked", "true");

  // Uncheck all, then undo.
  await menu(copy.list.uncheckAll);
  for (const n of ["Rice", "Beans", "Salsa"]) {
    await expect(item(page, n)).toHaveAttribute("aria-checked", "false");
  }
  await toast(page, copy.list.unchecked(3))
    .getByRole("button", { name: copy.common.undo })
    .click();
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "true");

  // Uncheck all, and it syncs.
  await menu(copy.list.uncheckAll);
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "false");
  await synced(page);
  await page.reload();
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "false");

  // Delete the checked items, after a confirmation, then undo.
  await item(page, "Salsa").click();
  await expect(item(page, "Salsa")).toHaveAttribute("aria-checked", "true");
  const deleteChecked = async () => {
    await menu(copy.list.deleteChecked);
    await dialog(page, copy.list.deleteCheckedTitle(1, name))
      .getByRole("button", { name: copy.list.deleteCheckedConfirm })
      .click();
    await expect(item(page, "Salsa")).toHaveCount(0);
    await expect(item(page, "Rice")).toBeVisible();
  };
  await deleteChecked();
  await toast(page, copy.list.deletedChecked(1))
    .getByRole("button", { name: copy.common.undo })
    .click();
  await expect(item(page, "Salsa")).toBeVisible();

  // Delete them again, and it syncs.
  await deleteChecked();
  await synced(page);
  await page.reload();
  await expect(item(page, "Salsa")).toHaveCount(0);
  await expect(item(page, "Beans")).toBeVisible();
});

test("rename a list from its header", async ({ page }) => {
  await signIn(page);
  const name = `Header ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  await page.getByRole("button", { name: copy.list.actions }).click();
  await page.getByRole("menuitem", { name: copy.common.rename }).click();
  const input = page.getByLabel(copy.lists.renameLabel(name));
  await input.fill(`${name} 2`);
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: `${name} 2` }),
  ).toBeVisible();
});
