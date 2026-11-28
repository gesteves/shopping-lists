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
  const emily = await browser.newPage();
  const haley = await browser.newPage();
  try {
    await signIn(emily);
    await signIn(haley, E2E_SECOND_EMAIL, "Haley");

    const gifts = uniqueName("Gifts");
    await createPrivateList(emily, gifts);
    const row = listIndex(emily).getByRole("link", { name: gifts });
    await expect(
      row.getByRole("img", { name: copy.lists.private }),
    ).toBeVisible();
    await openList(emily, gifts);
    const id = emily.url().split("/lists/")[1];
    // A rare name, so the autocomplete test below finds only this one.
    const secret = `Telescope${randomUUID().slice(0, 4)}`;
    await add(emily, secret);
    // A private list sends no push: no Notifications switch.
    await expect(
      emily.getByRole("switch", { name: copy.list.notifications }),
    ).toHaveCount(0);
    await synced(emily);

    // Haley's device never gets it.
    const shared = uniqueName("Shared");
    await createList(haley, shared);
    await expect(
      listIndex(haley).getByRole("link", { name: shared }),
    ).toBeVisible();
    await expect(
      listIndex(haley).getByRole("link", { name: gifts }),
    ).toHaveCount(0);
    expect(await localIds(haley)).not.toContain(id);
    await haley.goto(`/lists/${id}`);
    await expect(haley.getByText(copy.list.notFound)).toBeVisible();

    // On a shared list, Emily's autocomplete leaves out the private names.
    await emily.goto("/");
    await openList(emily, shared);
    const box = emily.getByRole("combobox", { name: copy.addBar.name });
    await box.fill(secret.slice(0, 9).toLowerCase());
    await expect(
      emily.getByRole("option", { name: secret, exact: true }),
    ).toHaveCount(0);
    await box.fill("");

    // Move does not offer the private list; Copy does.
    await add(emily, "Wrapping paper");
    await itemAction(emily, "Wrapping paper", copy.item.copy);
    const picker = dialog(emily, copy.item.copyTitle("Wrapping paper"));
    await picker.getByRole("combobox", { name: copy.item.targets }).click();
    await expect(
      picker.getByRole("option", { name: new RegExp(gifts) }),
    ).toBeVisible();
    // Close the listbox, then the dialog.
    await emily.keyboard.press("Escape");
    await picker.getByRole("button", { name: copy.common.cancel }).click();
    await expect(picker).toBeHidden();
    await itemAction(emily, "Wrapping paper", copy.item.move);
    const mover = dialog(emily, copy.item.moveTitle("Wrapping paper"));
    await mover.getByRole("combobox", { name: copy.item.targets }).click();
    await expect(mover.getByRole("option").first()).toBeVisible();
    await expect(
      mover.getByRole("option", { name: new RegExp(gifts) }),
    ).toHaveCount(0);
    // Close the listbox, then the dialog.
    await emily.keyboard.press("Escape");
    await mover.getByRole("button", { name: copy.common.cancel }).click();
    await expect(mover).toBeHidden();
  } finally {
    await emily.close();
    await haley.close();
  }
});

test("making a list private takes it from the other person, and sharing gives it back", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const emily = await browser.newPage();
  const haley = await browser.newPage();
  try {
    await signIn(emily);
    await signIn(haley, E2E_SECOND_EMAIL, "Haley");

    const name = uniqueName("Party");
    await createList(emily, name);
    await synced(emily);
    await expect(listIndex(haley).getByRole("link", { name })).toBeVisible();
    await openList(haley, name);
    await add(haley, "Balloons");
    await synced(haley);

    await openList(emily, name);
    await expect(
      emily.getByRole("checkbox", { name: /^Balloons\b/ }),
    ).toBeVisible();
    const id = emily.url().split("/lists/")[1];

    // The dialog tells Emily that Haley loses their item too.
    await listMenu(emily, copy.privacy.makePrivate);
    const confirm = dialog(emily, copy.privacy.makePrivateTitle(name));
    await expect(
      confirm.getByText(copy.privacy.makePrivateBody(["Haley"], 1)),
    ).toBeVisible();
    await confirm
      .getByRole("button", { name: copy.privacy.makePrivateConfirm })
      .click();
    await expect(
      emily.getByRole("heading", { level: 1 }).getByRole("img", {
        name: copy.lists.private,
      }),
    ).toBeVisible();
    await synced(emily);

    // Haley's open page loses the list, and their device has no row of it.
    await expect(haley.getByText(copy.list.notFound)).toBeVisible();
    await expect.poll(() => localIds(haley)).not.toContain(id);

    // Share again: Haley sees the list with its items.
    await listMenu(emily, copy.privacy.share(["Haley"]));
    const share = dialog(emily, copy.privacy.shareTitle(name));
    await expect(
      share.getByText(copy.privacy.shareBody(["Haley"])),
    ).toBeVisible();
    await share
      .getByRole("button", { name: copy.privacy.shareConfirm })
      .click();
    await synced(emily);
    await haley.goto(`/lists/${id}`);
    await expect(
      haley.getByRole("checkbox", { name: /^Balloons\b/ }),
    ).toBeVisible();
    // Haley did not make the list: they cannot change its privacy.
    await haley.getByRole("button", { name: copy.list.actions }).click();
    await expect(
      haley.getByRole("menuitem", { name: copy.privacy.makePrivate }),
    ).toHaveCount(0);
  } finally {
    await emily.close();
    await haley.close();
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
