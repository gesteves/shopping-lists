import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { dialog, signIn, synced } from "./helpers";

/** Make a list in the UI and open it. */
async function openNewList(page: Page) {
  const name = `Items ${randomUUID().slice(0, 8)}`;
  const index = page
    .getByRole("region", { name: "Lists" })
    .filter({ visible: true });
  await index.getByLabel("New list name").fill(name);
  await index.getByRole("button", { name: "Create" }).click();
  await index.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return name;
}

async function add(page: Page, name: string) {
  await page.getByLabel("Item name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(item(page, name)).toBeVisible();
}

function item(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

/** The item names, in the order on the screen. */
async function order(page: Page) {
  return page
    .getByRole("list", { name: "Items" })
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
  await expect(
    page
      .getByRole("main")
      .getByText("3 to get", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();

  // Check: the item goes below the unchecked items.
  await item(page, "Bread").click();
  await expect(item(page, "Bread")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => order(page)).toEqual(["Eggs", "Milk", "Bread"]);
  await expect(
    page
      .getByRole("main")
      .getByText("2 to get", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();

  // Uncheck: it goes back to the top.
  await item(page, "Bread").click();
  await expect(item(page, "Bread")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => order(page)).toEqual(["Bread", "Eggs", "Milk"]);

  // Edit the name, the quantity, and the notes.
  await page.getByRole("button", { name: "Edit Milk" }).click();
  const sheet = dialog(page, "Edit item");
  await expect(sheet.getByText(/^Added by Ana · just now$/)).toBeVisible();
  await sheet.getByLabel("Name").fill("Oat milk");
  await sheet.getByRole("button", { name: "More" }).click();
  await sheet.getByRole("button", { name: "More" }).click();
  await sheet.getByLabel("Notes").fill("Barista edition");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Oat milk")).toContainText("×3");
  await expect(item(page, "Oat milk")).toContainText("Barista edition");
  await expect.poll(() => order(page)).toEqual(["Oat milk", "Bread", "Eggs"]);

  // Delete from the sheet.
  await page.getByRole("button", { name: "Edit Eggs" }).click();
  await sheet.getByRole("button", { name: "Delete" }).click();
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
  await page.getByRole("button", { name: "Edit Pears" }).click();
  const sheet = dialog(page, "Edit item");
  await sheet.getByLabel("Notes").fill("Ripe");
  await sheet.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Edit Plums" }).click();
  await sheet.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/changes to sync/)).toBeVisible();
  await expect.poll(() => order(page)).toEqual(["Pears", "Apples"]);

  await context.setOffline(false);
  await synced(page);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["Pears", "Apples"]);
  await expect(item(page, "Apples")).toHaveAttribute("aria-checked", "true");
  await expect(item(page, "Pears")).toContainText("Ripe");
});

test("fast entry keeps every item", async ({ page }) => {
  await signIn(page);
  await openNewList(page);
  const names = ["Bananas", "Greek yogurt", "Sourdough", "Coffee beans"];
  for (const name of names) {
    await page.getByLabel("Item name").fill(name);
    await page.getByLabel("Item name").press("Enter");
  }
  await expect
    .poll(async () => (await order(page)).sort())
    .toEqual([...names].sort());
});
