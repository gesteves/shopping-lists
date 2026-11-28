import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import { serialize } from "../src/shared/hlc";
import {
  anyCount,
  createList,
  dialog,
  escapeRegExp,
  listIndex,
  openList,
  signIn,
  synced,
  itemAction,
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
  await itemAction(page, "Milk", copy.item.edit);
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

  // Delete from the menu.
  await itemAction(page, "Eggs", copy.common.delete);
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
  await itemAction(page, "Pears", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  await sheet.getByLabel(copy.itemSheet.notes).fill("Ripe");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await itemAction(page, "Plums", copy.common.delete);
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

test("the quantity badge is centered on the last line of the name", async ({
  page,
}) => {
  await signIn(page);
  await openNewList(page);
  const short = "Coffee";
  const long =
    "Extra large family size box of whole grain breakfast cereal with dried strawberries, almonds, and honey clusters";
  await add(page, short);
  await add(page, long);
  for (const name of [short, long]) {
    await itemAction(page, name, copy.item.edit);
    const sheet = dialog(page, copy.itemSheet.title);
    await sheet.getByRole("button", { name: copy.stepper.increment }).click();
    await sheet.getByRole("button", { name: copy.common.save }).click();
    await expect(sheet).toBeHidden();
    await expect(item(page, name)).toContainText(copy.item.quantity(2));
  }

  for (const name of [short, long]) {
    const { lines, offset } = await item(page, name)
      .locator("wa-badge")
      .evaluate((badge) => {
        const rects =
          badge.parentElement!.previousElementSibling!.getClientRects();
        const line = rects[rects.length - 1];
        const box = badge.getBoundingClientRect();
        return {
          lines: rects.length,
          offset: box.top + box.height / 2 - (line.top + line.height / 2),
        };
      });
    if (name === long) expect(lines).toBeGreaterThan(1);
    expect(Math.abs(offset), name).toBeLessThanOrEqual(2);
  }
});

/** The item names in the local Dexie database of `page`. */
function localItemNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("shopping-lists");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction("items").objectStore("items").getAll();
          all.onsuccess = () => {
            resolve(all.result.map((i: { name: string }) => i.name));
            db.close();
          };
        };
      }),
  );
}

test("the sheet keeps the edits of the other person", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await openNewList(page);
  await add(page, "Milk");
  await add(page, "Eggs");
  await synced(page);
  const sheet = dialog(page, copy.itemSheet.title);

  const ben = await browser.newPage();
  try {
    await signIn(ben, E2E_SECOND_EMAIL, "Ben");
    await ben.goto(page.url());
    const benSheet = dialog(ben, copy.itemSheet.title);
    await itemAction(ben, "Milk", copy.item.edit);
    await expect(benSheet.getByLabel(copy.itemSheet.name)).toBeVisible();

    // Ana renames the item while the sheet of Ben is open.
    await itemAction(page, "Milk", copy.item.edit);
    await sheet.getByLabel(copy.itemSheet.name).fill("Oat milk");
    await sheet.getByRole("button", { name: copy.common.save }).click();
    await expect(sheet).toBeHidden();
    await synced(page);
    await expect.poll(() => localItemNames(ben)).toContain("Oat milk");

    // Ben changes only the quantity. The rename stays.
    await benSheet
      .getByRole("button", { name: copy.stepper.increment })
      .click();
    await benSheet.getByRole("button", { name: copy.common.save }).click();
    await expect(benSheet).toBeHidden();
    await expect(item(ben, "Oat milk")).toContainText(copy.item.quantity(2));
    await expect(item(page, "Oat milk")).toContainText(copy.item.quantity(2));

    // Ana deletes an item while the sheet of Ben is open: it closes.
    await itemAction(ben, "Eggs", copy.item.edit);
    await expect(benSheet.getByLabel(copy.itemSheet.name)).toBeVisible();
    await itemAction(page, "Eggs", copy.common.delete);
    await expect(benSheet).toBeHidden();
    await expect(
      ben.locator("wa-toast-item", { hasText: copy.itemSheet.gone("Eggs") }),
    ).toBeVisible();
    await expect(item(ben, "Eggs")).toHaveCount(0);
  } finally {
    await ben.close();
  }
});

test.describe("sync errors", () => {
  // page.route does not see the requests that go through a service worker.
  test.use({ serviceWorkers: "block" });

  test("the header shows a sync error", async ({ page }) => {
    await signIn(page);
    await page.route("**/api/sync/pull*", (route) =>
      route.fulfill({ status: 500 }),
    );
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: copy.sync.error }),
    ).toBeVisible();
  });
});

test("Cancel in the dedupe prompt keeps the name, quantity, and notes", async ({
  page,
}) => {
  await signIn(page);
  await openNewList(page);
  await add(page, "Milk");
  const bar = page.getByRole("form", { name: copy.addBar.label });

  await bar.getByRole("combobox", { name: copy.addBar.name }).fill("milk");
  await bar.getByRole("button", { name: copy.addBar.details }).click();
  await bar.getByRole("button", { name: copy.stepper.increment }).click();
  await bar.getByRole("textbox", { name: copy.addBar.notes }).fill("Oat");
  await bar.getByRole("button", { name: copy.addBar.add, exact: true }).click();
  const prompt = dialog(page, copy.addBar.duplicateTitle("Milk"));
  await expect(prompt.getByText(copy.addBar.duplicateBody(2, 3))).toBeVisible();
  await prompt.getByRole("button", { name: copy.common.cancel }).click();
  await expect(prompt).toBeHidden();

  await expect(
    bar.getByRole("combobox", { name: copy.addBar.name }),
  ).toHaveValue("milk");
  await expect(
    bar.getByRole("textbox", { name: copy.addBar.notes }),
  ).toHaveValue("Oat");
  await expect(
    bar.getByRole("spinbutton", { name: copy.addBar.quantity }),
  ).toHaveValue("2");
});

test("an add that fails on the device shows a toast", async ({ page }) => {
  await signIn(page);
  await openNewList(page);
  await synced(page);
  // IndexedDB refuses each new row, as when the disk is full. The outbox
  // entry of a write is a new row.
  await page.evaluate(() => {
    IDBObjectStore.prototype.add = () => {
      throw new DOMException("Full", "QuotaExceededError");
    };
  });
  await page.getByLabel(copy.addBar.name).fill("Tent");
  await page.getByLabel(copy.addBar.name).press("Enter");
  await expect(
    page.locator("wa-toast-item", { hasText: copy.addBar.failed("Tent") }),
  ).toBeVisible();
  await expect(item(page, "Tent")).toHaveCount(0);
});

test("adds to a list deleted offline give one toast and one new list", async ({
  page,
  context,
  browser,
}) => {
  await signIn(page);
  const name = await openNewList(page);
  await synced(page);
  const listId = new URL(page.url()).pathname.split("/").pop()!;

  // Offline, this device adds three items. Then Ben deletes the list.
  await context.setOffline(true);
  for (const thing of ["Tent", "Stove", "Lantern"]) {
    await page.getByLabel(copy.addBar.name).fill(thing);
    await page.getByLabel(copy.addBar.name).press("Enter");
    await expect(item(page, thing)).toBeVisible();
  }
  const ben = await browser.newPage();
  try {
    await signIn(ben, E2E_SECOND_EMAIL, "Ben");
    const clientId = randomUUID();
    const res = await ben.request.post("/api/sync/push", {
      data: {
        clientId,
        ops: [
          {
            opId: randomUUID(),
            clientId,
            hlc: serialize({ wall: Date.now(), counter: 0, node: clientId }),
            type: "deleteList",
            args: { listId },
          },
        ],
      },
    });
    expect(res.status()).toBe(200);
  } finally {
    await ben.close();
  }

  // Online, the server refuses the three adds. One toast offers a new list.
  await context.setOffline(false);
  const toast = page.locator("wa-toast-item", {
    hasText: copy.toasts.listDeletedMany(name, 3, "add"),
  });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("wa-toast-item", { hasText: name })).toHaveCount(1);
  await toast.getByRole("button", { name: copy.toasts.recreate }).click();
  await expect(page).not.toHaveURL(new RegExp(listId));
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  for (const thing of ["Tent", "Stove", "Lantern"]) {
    await expect(item(page, thing)).toBeVisible();
  }
  await synced(page);

  // One new list on the index.
  await page.goto("/");
  await expect(
    listIndex(page).getByRole("link", {
      name: new RegExp(`^${escapeRegExp(name)}\\b`),
    }),
  ).toHaveCount(1);
});
