// The "…" menu of an item row (#131): Edit, Move, Copy, Out of stock or In
// stock, and Delete. See "UI" in docs/PLAN.md.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import {
  createList,
  dialog,
  itemAction,
  openList,
  signIn,
  synced,
} from "./helpers";

async function add(page: Page, name: string) {
  await page.getByLabel(copy.addBar.name).fill(name);
  await page
    .getByRole("button", { name: copy.addBar.add, exact: true })
    .click();
  await expect(item(page, name)).toBeVisible();
}

function item(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

function toast(page: Page, text: string) {
  return page.locator("wa-toast-item").filter({ hasText: text }).first();
}

/** The badge of an out-of-stock item. */
function badge(page: Page, name: string) {
  return item(page, name)
    .locator("wa-badge")
    .filter({ hasText: copy.item.outOfStock });
}

/** Two new lists. The page shows the first one. */
async function twoLists(page: Page) {
  const id = randomUUID().slice(0, 8);
  const from = `Store A ${id}`;
  const to = `Store B ${id}`;
  await createList(page, to);
  await createList(page, from);
  await openList(page, from);
  return { from, to };
}

/** The menu items of an item, by name. Opens the menu, then closes it. */
async function menuItems(page: Page, name: string) {
  await page
    .getByRole("button", { name: copy.item.more(name), exact: true })
    .filter({ visible: true })
    .click();
  const items = page.getByRole("menuitem").filter({ visible: true });
  await expect(items.first()).toBeVisible();
  const names = await items.allInnerTexts();
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);
  return names.map((n) => n.trim());
}

test("the menu edits an item, and the sheet has no Move or Delete", async ({
  page,
}) => {
  await signIn(page);
  await twoLists(page);
  await add(page, "Milk");

  expect(await menuItems(page, "Milk")).toEqual([
    copy.item.edit,
    copy.item.move,
    copy.item.copy,
    copy.item.outOfStock,
    copy.common.delete,
  ]);

  await itemAction(page, "Milk", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  await expect(sheet.getByLabel(copy.itemSheet.name)).toBeVisible();
  await expect(sheet.getByRole("combobox")).toHaveCount(0);
  await expect(
    sheet.getByRole("button", { name: copy.common.delete }),
  ).toHaveCount(0);
  await sheet.getByLabel(copy.itemSheet.notes).fill("2%");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Milk")).toContainText("2%");

  // Delete, then undo.
  await itemAction(page, "Milk", copy.common.delete);
  await expect(item(page, "Milk")).toHaveCount(0);
  await toast(page, copy.item.deleted("Milk"))
    .getByRole("button", { name: copy.common.undo })
    .click();
  await expect(item(page, "Milk")).toBeVisible();
});

test("move and copy an item to another list", async ({ page }) => {
  await signIn(page);
  const { to } = await twoLists(page);
  await add(page, "Eggs");
  await add(page, "Bread");

  // Move: the item goes to the other list.
  await itemAction(page, "Eggs", copy.item.move);
  const move = dialog(page, copy.item.moveTitle("Eggs"));
  await move.getByRole("button", { name: to }).click();
  await expect(move).toBeHidden();
  await expect(item(page, "Eggs")).toHaveCount(0);
  await expect(toast(page, copy.item.moved("Eggs", to))).toBeVisible();

  // Copy: the item stays, and the other list gets one with the same fields.
  await itemAction(page, "Bread", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  await sheet.getByLabel(copy.itemSheet.notes).fill("Sourdough");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await itemAction(page, "Bread", copy.item.copy);
  await dialog(page, copy.item.copyTitle("Bread"))
    .getByRole("button", { name: to })
    .click();
  await expect(toast(page, copy.item.copied("Bread", to))).toBeVisible();
  await expect(item(page, "Bread")).toBeVisible();

  // A second copy finds the name on the list: no second item.
  await itemAction(page, "Bread", copy.item.copy);
  await dialog(page, copy.item.copyTitle("Bread"))
    .getByRole("button", { name: to })
    .click();
  await expect(toast(page, copy.item.copyOnList("Bread", to))).toBeVisible();
  await synced(page);

  await page.goto("/");
  await openList(page, to);
  await expect(item(page, "Eggs")).toBeVisible();
  await expect(item(page, "Bread")).toHaveCount(1);
  await expect(item(page, "Bread")).toContainText("Sourdough");
});

test("out of stock: the badge, the offer, in stock, and a check", async ({
  page,
}) => {
  await signIn(page);
  await twoLists(page);
  await add(page, "Milk");

  // Mark it: a badge, and a toast that offers Move and Copy.
  await itemAction(page, "Milk", copy.item.outOfStock);
  await expect(badge(page, "Milk")).toBeVisible();
  const offer = toast(page, copy.item.markedOutOfStock("Milk"));
  await expect(
    offer.getByRole("button", { name: copy.item.move }),
  ).toBeVisible();
  await expect(
    offer.getByRole("button", { name: copy.item.copy }),
  ).toBeVisible();
  // To decline, do nothing: the item stays on this list, out of stock.
  await synced(page);
  await page.reload();
  await expect(badge(page, "Milk")).toBeVisible();

  // The menu now has In stock.
  expect(await menuItems(page, "Milk")).toContain(copy.item.inStock);
  await itemAction(page, "Milk", copy.item.inStock);
  await expect(badge(page, "Milk")).toHaveCount(0);

  // A check marks it in stock, and a checked item has no stock item.
  await itemAction(page, "Milk", copy.item.outOfStock);
  await expect(badge(page, "Milk")).toBeVisible();
  await item(page, "Milk").click();
  await expect(item(page, "Milk")).toHaveAttribute("aria-checked", "true");
  await expect(badge(page, "Milk")).toHaveCount(0);
  const checkedMenu = await menuItems(page, "Milk");
  expect(checkedMenu).not.toContain(copy.item.outOfStock);
  expect(checkedMenu).not.toContain(copy.item.inStock);
  expect(checkedMenu).toContain(copy.item.move);

  // The server has the same state.
  await synced(page);
  await page.reload();
  await expect(item(page, "Milk")).toHaveAttribute("aria-checked", "true");
  await expect(badge(page, "Milk")).toHaveCount(0);
});

test("out of stock, then move from the offer: no badge on the other list", async ({
  page,
}) => {
  await signIn(page);
  const { to } = await twoLists(page);
  await add(page, "Basil");
  await itemAction(page, "Basil", copy.item.outOfStock);
  await expect(badge(page, "Basil")).toBeVisible();
  await toast(page, copy.item.markedOutOfStock("Basil"))
    .getByRole("button", { name: copy.item.move })
    .click();
  await dialog(page, copy.item.moveTitle("Basil"))
    .getByRole("button", { name: to })
    .click();
  await expect(item(page, "Basil")).toHaveCount(0);
  await synced(page);

  await page.goto("/");
  await openList(page, to);
  await expect(item(page, "Basil")).toBeVisible();
  await expect(badge(page, "Basil")).toHaveCount(0);
});

test("out of stock, then copy from the offer: the copy is in stock", async ({
  page,
}) => {
  await signIn(page);
  const { from, to } = await twoLists(page);
  await add(page, "Limes");
  await itemAction(page, "Limes", copy.item.outOfStock);
  await toast(page, copy.item.markedOutOfStock("Limes"))
    .getByRole("button", { name: copy.item.copy })
    .click();
  await dialog(page, copy.item.copyTitle("Limes"))
    .getByRole("button", { name: to })
    .click();
  await expect(toast(page, copy.item.copied("Limes", to))).toBeVisible();
  // The item stays out of stock on this list.
  await expect(badge(page, "Limes")).toBeVisible();
  await synced(page);

  await page.goto("/");
  await openList(page, to);
  await expect(item(page, "Limes")).toBeVisible();
  await expect(badge(page, "Limes")).toHaveCount(0);
  await page.goto("/");
  await openList(page, from);
  await expect(badge(page, "Limes")).toBeVisible();
});

test("the other person sees the badge", async ({ page, browser }) => {
  await signIn(page);
  const { from } = await twoLists(page);
  await add(page, "Rice");
  await synced(page);
  const ben = await browser.newPage();
  try {
    await signIn(ben, E2E_SECOND_EMAIL, "Ben");
    await openList(ben, from);
    await expect(item(ben, "Rice")).toBeVisible();
    await itemAction(page, "Rice", copy.item.outOfStock);
    await expect(badge(ben, "Rice")).toBeVisible();
  } finally {
    await ben.close();
  }
});
