// The URL of an item (#140): a field in the item sheet, the host on the row,
// and "Visit page" in the item menu. See "UI" in docs/PLAN.md.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  createList,
  dialog,
  itemAction,
  openList,
  signIn,
  synced,
} from "./helpers";

function item(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

async function newListWith(page: Page, name: string) {
  const list = `Links ${randomUUID().slice(0, 8)}`;
  await createList(page, list);
  await openList(page, list);
  await page.getByLabel(copy.addBar.name).fill(name);
  await page
    .getByRole("button", { name: copy.addBar.add, exact: true })
    .click();
  await expect(item(page, name)).toBeVisible();
  return list;
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

test("a URL shows its host on the row, and Visit page opens it", async ({
  page,
  context,
}) => {
  // The new tab gets a stub page: the tests do not go to the internet.
  await context.route("https://shop.example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Coffee</p>" }),
  );
  await signIn(page);
  const list = await newListWith(page, "Coffee");
  expect(await menuItems(page, "Coffee")).not.toContain(copy.item.visitPage);

  // No scheme: the app adds https://.
  await itemAction(page, "Coffee", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  await sheet.getByLabel(copy.itemSheet.url).fill("shop.example.com/coffee");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Coffee")).toContainText("shop.example.com");
  await expect(item(page, "Coffee")).toHaveAccessibleName(
    new RegExp(`${copy.item.linkPrefix}shop\\.example\\.com`),
  );

  expect(await menuItems(page, "Coffee")).toEqual([
    copy.item.edit,
    copy.item.visitPage,
    copy.item.move,
    copy.item.copy,
    copy.item.outOfStock,
    copy.common.delete,
  ]);

  const tab = context.waitForEvent("page");
  await itemAction(page, "Coffee", copy.item.visitPage);
  const opened = await tab;
  await expect(opened).toHaveURL("https://shop.example.com/coffee");
  await opened.close();

  // The URL syncs.
  await synced(page);
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: list }),
  ).toBeVisible();
  await expect(item(page, "Coffee")).toContainText("shop.example.com");
});

test("the sheet refuses a URL that is not a web address", async ({ page }) => {
  await signIn(page);
  await newListWith(page, "Tea");

  await itemAction(page, "Tea", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  const field = sheet.getByLabel(copy.itemSheet.url);
  await field.fill("javascript:alert(1)");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  // The form does not submit: the sheet stays open.
  await expect(sheet.getByLabel(copy.itemSheet.name)).toBeVisible();
  await expect(sheet.locator("wa-input").nth(1)).toHaveJSProperty(
    "validationMessage",
    copy.itemSheet.urlInvalid,
  );

  // A good URL saves. Then an empty field removes it.
  await field.fill("https://shop.example.com/tea");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Tea")).toContainText("shop.example.com");

  await itemAction(page, "Tea", copy.item.edit);
  await expect(field).toHaveValue("https://shop.example.com/tea");
  await field.fill("");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(item(page, "Tea")).not.toContainText("shop.example.com");
  expect(await menuItems(page, "Tea")).not.toContain(copy.item.visitPage);
});
