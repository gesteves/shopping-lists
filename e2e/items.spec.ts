import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  anyCount,
  createList,
  dialog,
  openList,
  signIn,
  synced,
} from "./helpers";

/** Make a list in the UI and open it. */
async function openNewList(page: Page) {
  const name = `Items ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  return name;
}

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

/** The item names, in the order on the screen. */
async function order(page: Page) {
  return page
    .getByRole("list", { name: copy.list.items })
    .getByRole("checkbox")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-name")));
}

test("add, check, uncheck, edit, and delete items, in order", async ({
  page,
}) => {
  await signIn(page);
  await openNewList(page);

  await add(page, "Milk");
  await add(page, "Eggs");
  await add(page, "Bread");
  // The last updated first.
  await expect.poll(() => order(page)).toEqual(["Bread", "Eggs", "Milk"]);

  // Check: the item goes below the unchecked items.
  await item(page, "Bread").click();
  await expect(item(page, "Bread")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => order(page)).toEqual(["Eggs", "Milk", "Bread"]);

  // Uncheck: it goes back to the top.
  await item(page, "Bread").click();
  await expect(item(page, "Bread")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => order(page)).toEqual(["Bread", "Eggs", "Milk"]);

  // Edit the name, the quantity, and the notes.
  await page.getByRole("button", { name: copy.item.edit("Milk") }).click();
  const sheet = dialog(page, copy.itemSheet.title);
  await expect(
    sheet.getByText(copy.item.added("Ana", copy.time.justNow), {
      exact: true,
    }),
  ).toBeVisible();
  await sheet.getByLabel(copy.itemSheet.name).fill("Oat milk");
  await sheet.getByRole("button", { name: copy.stepper.increment }).click();
  await sheet.getByRole("button", { name: copy.stepper.increment }).click();
  await sheet.getByLabel(copy.itemSheet.notes).fill("Barista edition");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Oat milk")).toContainText(copy.item.quantity(3));
  await expect(item(page, "Oat milk")).toContainText("Barista edition");
  await expect.poll(() => order(page)).toEqual(["Oat milk", "Bread", "Eggs"]);

  // Delete from the sheet.
  await page.getByRole("button", { name: copy.item.edit("Eggs") }).click();
  await sheet.getByRole("button", { name: copy.common.delete }).click();
  await expect(item(page, "Eggs")).toHaveCount(0);

  // The server has it all: a reload shows the same list.
  await synced(page);
  await page.reload();
  await expect(item(page, "Oat milk")).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["Oat milk", "Bread"]);
});

test("every item action works offline and syncs when online", async ({
  page,
  context,
}) => {
  await signIn(page);
  await openNewList(page);
  await add(page, "Apples");
  await add(page, "Pears");
  await synced(page);

  await context.setOffline(true);
  await add(page, "Plums");
  await item(page, "Apples").click();
  await page.getByRole("button", { name: copy.item.edit("Pears") }).click();
  const sheet = dialog(page, copy.itemSheet.title);
  await sheet.getByLabel(copy.itemSheet.notes).fill("Ripe");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await page.getByRole("button", { name: copy.item.edit("Plums") }).click();
  await sheet.getByRole("button", { name: copy.common.delete }).click();
  await expect(
    page.getByText(anyCount(copy.sync.offlineWithChanges)),
  ).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["Pears", "Apples"]);

  await context.setOffline(false);
  await synced(page);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["Pears", "Apples"]);
  await expect(item(page, "Apples")).toHaveAttribute("aria-checked", "true");
  await expect(item(page, "Pears")).toContainText("Ripe");
});

test("the lists page shows the name of one item", async ({ page }) => {
  await signIn(page);
  const name = await openNewList(page);
  await add(page, "Milk");
  await page.goto("/");
  const row = page
    .getByRole("region", { name: copy.lists.heading })
    .filter({ visible: true })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(row).toContainText(copy.lists.names(["Milk"]));
});

test("fast entry keeps every item", async ({ page }) => {
  await signIn(page);
  await openNewList(page);
  const names = ["Bananas", "Greek yogurt", "Sourdough", "Coffee beans"];
  for (const name of names) {
    await page.getByLabel(copy.addBar.name).fill(name);
    await page.getByLabel(copy.addBar.name).press("Enter");
  }
  await expect
    .poll(async () => (await order(page)).sort())
    .toEqual([...names].sort());
});
