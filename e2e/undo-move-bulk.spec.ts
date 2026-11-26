import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { dialog, signIn, synced } from "./helpers";

function index(page: Page) {
  return page.getByRole("region", { name: "Lists" }).filter({ visible: true });
}

async function createList(page: Page, name: string) {
  await index(page).getByLabel("New list name").fill(name);
  await index(page).getByRole("button", { name: "Create" }).click();
  await expect(index(page).getByRole("link", { name })).toBeVisible();
}

async function openList(page: Page, name: string) {
  await index(page).getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function add(page: Page, ...names: string[]) {
  for (const name of names) {
    await page.getByLabel("Item name").fill(name);
    await page.getByLabel("Item name").press("Enter");
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
    await signIn(b, E2E_SECOND_EMAIL, "Ben");
    const name = `Undo ${randomUUID().slice(0, 8)}`;
    await createList(a, name);
    await openList(a, name);
    await add(a, "Lemons");
    await synced(a);
    await openList(b, name);
    await expect(item(b, "Lemons")).toBeVisible();

    await a.getByRole("button", { name: "Edit Lemons" }).click();
    await dialog(a, "Edit item")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(item(a, "Lemons")).toHaveCount(0);
    await expect(item(b, "Lemons")).toHaveCount(0);

    await toast(a, "Deleted “Lemons”.")
      .getByRole("button", { name: "Undo" })
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
  await index(page)
    .getByRole("button", { name: `More for ${name}` })
    .click();
  await index(page).getByRole("menuitem", { name: "Delete" }).click();
  await dialog(page, `Delete the “${name}” list?`)
    .getByRole("button", { name: "Delete list" })
    .click();
  await expect(index(page).getByRole("link", { name })).toHaveCount(0);
  await toast(page, `Deleted the “${name}” list.`)
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(index(page).getByRole("link", { name })).toBeVisible();
});

test("move an item to a different list", async ({ page }) => {
  await signIn(page);
  const from = `From ${randomUUID().slice(0, 8)}`;
  const to = `To ${randomUUID().slice(0, 8)}`;
  await createList(page, to);
  await createList(page, from);
  await openList(page, from);
  await add(page, "Tortillas");

  await page.getByRole("button", { name: "Edit Tortillas" }).click();
  const sheet = dialog(page, "Edit item");
  await sheet.getByRole("combobox", { name: "Move to" }).click();
  await sheet.getByRole("option", { name: to }).click();
  await expect(item(page, "Tortillas")).toHaveCount(0);
  await expect(
    toast(page, `Moved “Tortillas” to the “${to}” list.`),
  ).toBeVisible();
  await synced(page);

  await page.reload();
  await expect(item(page, "Tortillas")).toHaveCount(0);
  await page.goto("/");
  await openList(page, to);
  await expect(item(page, "Tortillas")).toBeVisible();
});

test("uncheck all and clear checked items, and they sync", async ({ page }) => {
  await signIn(page);
  const name = `Bulk ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  await add(page, "Rice", "Beans", "Salsa");
  await item(page, "Rice").click();
  await item(page, "Beans").click();
  await expect(item(page, "Beans")).toHaveAttribute("aria-checked", "true");

  // Uncheck all.
  await page.getByRole("button", { name: "List actions" }).click();
  await page.getByRole("menuitem", { name: "Uncheck all" }).click();
  for (const n of ["Rice", "Beans", "Salsa"]) {
    await expect(item(page, n)).toHaveAttribute("aria-checked", "false");
  }
  await synced(page);
  await page.reload();
  await expect(item(page, "Rice")).toHaveAttribute("aria-checked", "false");

  // Clear checked items, after a confirmation.
  await item(page, "Salsa").click();
  await expect(item(page, "Salsa")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "List actions" }).click();
  await page.getByRole("menuitem", { name: "Clear checked items" }).click();
  await dialog(page, `Clear 1 item checked off “${name}”?`)
    .getByRole("button", { name: "Clear" })
    .click();
  await expect(item(page, "Salsa")).toHaveCount(0);
  await expect(item(page, "Rice")).toBeVisible();
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
  await page.getByRole("button", { name: "List actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByLabel(`New name for “${name}”`);
  await input.fill(`${name} 2`);
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: `${name} 2` }),
  ).toBeVisible();
});
