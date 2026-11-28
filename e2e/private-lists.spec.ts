// Private lists (#154): only the creator sees the list and its items.
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import {
  createList,
  dialog,
  escapeRegExp,
  itemAction,
  listIndex,
  openList,
  scan,
  signIn,
  synced,
} from "./helpers";

function uniqueName(prefix: string) {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

/** Make a private list with the switch of the create form. */
async function createPrivateList(page: Page, name: string) {
  const index = listIndex(page);
  const control = index.getByRole("switch", { name: copy.lists.newPrivate });
  // The control itself, as the other switch tests do.
  const part = index
    .locator("wa-switch")
    .filter({
      has: page.getByRole("switch", { name: copy.lists.newPrivate }),
    })
    .locator('[part~="control"]');
  // A click before hydration ends is lost: try again until it is on.
  await expect(async () => {
    if (!(await control.isChecked())) await part.click();
    await expect(control).toBeChecked({ timeout: 1_000 });
  }).toPass();
  await createList(page, name);
  // The switch goes back to off after each create.
  await expect(control).not.toBeChecked();
}

async function add(page: Page, name: string) {
  const box = page.getByRole("combobox", { name: copy.addBar.name });
  await box.fill(name);
  await box.press("Enter");
  await expect(
    page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) }),
  ).toBeVisible();
}

/** The IDs of the lists and items in the local Dexie database. */
function localIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("shopping-lists");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const stores = ["lists", "items", "serverLists", "serverItems"];
          const tx = db.transaction(stores);
          const ids: string[] = [];
          for (const store of stores) {
            const all = tx.objectStore(store).getAll();
            all.onsuccess = () =>
              ids.push(...all.result.map((r: { id: string }) => r.id));
          }
          tx.oncomplete = () => {
            db.close();
            resolve(ids);
          };
        };
      }),
  );
}

async function listMenu(page: Page, action: string | RegExp) {
  await page.getByRole("button", { name: copy.list.actions }).click();
  await page
    .getByRole("menuitem", {
      name: action,
      exact: typeof action === "string",
    })
    .click();
}

test("a private list shows only to its creator", async ({ browser }) => {
  // Two users and many steps: slow on a busy CI runner.
  test.setTimeout(60_000);
  const ana = await browser.newPage();
  const ben = await browser.newPage();
  try {
    await signIn(ana);
    await signIn(ben, E2E_SECOND_EMAIL, "Ben");

    const gifts = uniqueName("Gifts");
    await createPrivateList(ana, gifts);
    const row = listIndex(ana).getByRole("link", { name: gifts });
    await expect(
      row.getByRole("img", { name: copy.lists.private }),
    ).toBeVisible();
    await openList(ana, gifts);
    const id = ana.url().split("/lists/")[1];
    // A rare name, so the autocomplete test below finds only this one.
    const secret = `Telescope${randomUUID().slice(0, 4)}`;
    await add(ana, secret);
    // A private list sends no push: no Notifications switch.
    await expect(
      ana.getByRole("switch", { name: copy.list.notifications }),
    ).toHaveCount(0);
    await synced(ana);

    // Ben's device never gets it.
    const shared = uniqueName("Shared");
    await createList(ben, shared);
    await expect(
      listIndex(ben).getByRole("link", { name: shared }),
    ).toBeVisible();
    await expect(listIndex(ben).getByRole("link", { name: gifts })).toHaveCount(
      0,
    );
    expect(await localIds(ben)).not.toContain(id);
    await ben.goto(`/lists/${id}`);
    await expect(ben.getByText(copy.list.notFound)).toBeVisible();

    // On a shared list, Ana's autocomplete leaves out the private names.
    await ana.goto("/");
    await openList(ana, shared);
    const box = ana.getByRole("combobox", { name: copy.addBar.name });
    await box.fill(secret.slice(0, 9).toLowerCase());
    await expect(
      ana.getByRole("option", { name: secret, exact: true }),
    ).toHaveCount(0);
    await box.fill("");

    // Move does not offer the private list; Copy does.
    await add(ana, "Wrapping paper");
    await itemAction(ana, "Wrapping paper", copy.item.copy);
    const picker = dialog(ana, copy.item.copyTitle("Wrapping paper"));
    await picker.getByRole("combobox", { name: copy.item.targets }).click();
    await expect(
      picker.getByRole("option", { name: new RegExp(gifts) }),
    ).toBeVisible();
    // Close the listbox, then the dialog.
    await ana.keyboard.press("Escape");
    await picker.getByRole("button", { name: copy.common.cancel }).click();
    await expect(picker).toBeHidden();
    await itemAction(ana, "Wrapping paper", copy.item.move);
    const mover = dialog(ana, copy.item.moveTitle("Wrapping paper"));
    await mover.getByRole("combobox", { name: copy.item.targets }).click();
    await expect(mover.getByRole("option").first()).toBeVisible();
    await expect(
      mover.getByRole("option", { name: new RegExp(gifts) }),
    ).toHaveCount(0);
    // Close the listbox, then the dialog.
    await ana.keyboard.press("Escape");
    await mover.getByRole("button", { name: copy.common.cancel }).click();
    await expect(mover).toBeHidden();
  } finally {
    await ana.close();
    await ben.close();
  }
});

test("making a list private takes it from the other person, and sharing gives it back", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const ana = await browser.newPage();
  const ben = await browser.newPage();
  try {
    await signIn(ana);
    await signIn(ben, E2E_SECOND_EMAIL, "Ben");

    const name = uniqueName("Party");
    await createList(ana, name);
    await synced(ana);
    await expect(listIndex(ben).getByRole("link", { name })).toBeVisible();
    await openList(ben, name);
    await add(ben, "Balloons");
    await synced(ben);

    await openList(ana, name);
    await expect(
      ana.getByRole("checkbox", { name: /^Balloons\b/ }),
    ).toBeVisible();
    const id = ana.url().split("/lists/")[1];

    // The dialog tells Ana that Ben loses his item too.
    await listMenu(ana, copy.privacy.makePrivate);
    const confirm = dialog(ana, copy.privacy.makePrivateTitle(name));
    await expect(
      confirm.getByText(copy.privacy.makePrivateBody(["Ben"], 1)),
    ).toBeVisible();
    await confirm
      .getByRole("button", { name: copy.privacy.makePrivateConfirm })
      .click();
    await expect(
      ana.getByRole("heading", { level: 1 }).getByRole("img", {
        name: copy.lists.private,
      }),
    ).toBeVisible();
    await synced(ana);

    // Ben's open page loses the list, and his device has no row of it.
    await expect(ben.getByText(copy.list.notFound)).toBeVisible();
    await expect.poll(() => localIds(ben)).not.toContain(id);

    // Share again: Ben sees the list with its items.
    await listMenu(ana, copy.privacy.share(["Ben"]));
    const share = dialog(ana, copy.privacy.shareTitle(name));
    await expect(
      share.getByText(copy.privacy.shareBody(["Ben"])),
    ).toBeVisible();
    await share
      .getByRole("button", { name: copy.privacy.shareConfirm })
      .click();
    await synced(ana);
    await ben.goto(`/lists/${id}`);
    await expect(
      ben.getByRole("checkbox", { name: /^Balloons\b/ }),
    ).toBeVisible();
    // Ben did not make the list: he cannot change its privacy.
    await ben.getByRole("button", { name: copy.list.actions }).click();
    await expect(
      ben.getByRole("menuitem", { name: copy.privacy.makePrivate }),
    ).toHaveCount(0);
  } finally {
    await ana.close();
    await ben.close();
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the private list screens pass axe (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      ...testInfo.project.use,
      colorScheme,
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      const name = uniqueName("A11y gifts");
      await createPrivateList(page, name);
      // The lock on the row, in the list index.
      await scan(page, "home with a private list");
      await openList(page, name);
      await add(page, "Scarf");
      await synced(page);
      await scan(page, "private list");
      // The other users can differ in a new database: match the start.
      await listMenu(
        page,
        new RegExp(`^${escapeRegExp(copy.privacy.share([]))}`),
      );
      await expect(
        page.getByRole("dialog", { name: copy.privacy.shareTitle(name) }),
      ).toBeVisible();
      await scan(page, "share dialog");
    } finally {
      await context.close();
    }
  });
}
