import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { DAY_MS } from "../src/shared/expiry";
import { serialize } from "../src/shared/hlc";
import {
  dialog,
  fakePushBrowser,
  removeFakeSubscription,
  saveFakeSubscription,
  settled,
  signIn,
  itemAction,
} from "./helpers";

// Long names and notes wrap (#129). No element goes past the right edge of
// a narrow screen, and the page does not scroll to the side.

/** One long word, with no spaces. */
const word = (prefix: string, length: number) =>
  `${prefix}${randomUUID().replaceAll("-", "")}`.padEnd(length, "x");

/** A list with long text in each place that shows it, through the sync API. */
async function seed(page: Page) {
  const clientId = randomUUID();
  const listId = randomUUID();
  let counter = 0;
  const op = (type: string, args: object, wall: number) => ({
    opId: randomUUID(),
    clientId,
    hlc: serialize({
      wall: Math.floor(wall),
      counter: counter++,
      node: clientId,
    }),
    type,
    args,
  });
  const now = Date.now();
  const created = now - 40 * DAY_MS;
  const listName = word("Longlist", 90);
  const names = {
    sentence: `Ready pasta ${randomUUID().slice(0, 8)}`,
    url: word("Longitem", 120),
    older: word("Olderitem", 120),
  };
  const ids = {
    sentence: randomUUID(),
    url: randomUUID(),
    older: randomUUID(),
  };
  const ops = [
    op("createList", { listId, name: listName }, created),
    op(
      "addItem",
      {
        itemId: ids.sentence,
        listId,
        name: names.sentence,
        notes:
          "Barilla Ready Pasta, Rotini (fully cooked, 60-second), 7 oz bags, the family size if they have it, else two of the small ones",
      },
      created,
    ),
    op(
      "addItem",
      {
        itemId: ids.url,
        listId,
        name: names.url,
        quantity: 3,
        notes: `https://shop.example.com/products/${word("ready-pasta-rotini-", 120)}`,
      },
      created + 1,
    ),
    op(
      "addItem",
      {
        itemId: ids.older,
        listId,
        name: names.older,
        notes: word("Oldernotes", 150),
      },
      created + 2,
    ),
    // Checked 25 days ago: it is in "Older items".
    op("check", { itemId: ids.older }, now - 25 * DAY_MS),
  ];
  const res = await page.request.post("/api/sync/push", {
    data: { clientId, ops },
  });
  expect(res.status()).toBe(200);
  return { listId, listName, names };
}

/**
 * The visible elements that go past the left or the right edge of the
 * viewport, the boxes that their text goes out of, and the side scroll of
 * the document.
 */
function overflow(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // The elements in the shadow roots too: the title of a dialog is there.
    const all = (root: Document | ShadowRoot): Element[] =>
      [...root.querySelectorAll("*")].flatMap((el) => [
        el,
        ...(el.shadowRoot ? all(el.shadowRoot) : []),
      ]);
    const name = (el: Element) =>
      `${el.localName}.${[...el.classList].join(".")}`;
    const wide = all(document).flatMap((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return [];
      if (rect.left >= -1 && rect.right <= width + 1) return [];
      return [
        `${name(el)} (${Math.round(rect.left)}–${Math.round(rect.right)})`,
      ];
    });
    // Text for screen readers only, in a box with a clip path.
    const hidden = (el: Element): boolean =>
      !!el.parentElement &&
      (getComputedStyle(el.parentElement).clipPath !== "none" ||
        hidden(el.parentElement));
    // Text that goes out of its box past the edge, where an ancestor clips
    // it (a toast). Not a box that scrolls or clips on purpose (a field,
    // sr-only text).
    const spill = all(document).flatMap((el) => {
      if (el.clientWidth === 0) return [];
      if (el.localName === "input" || el.localName === "textarea") return [];
      if (hidden(el)) return [];
      if (getComputedStyle(el).overflowX !== "visible") return [];
      const right = el.getBoundingClientRect().left + el.scrollWidth;
      if (right <= width + 1) return [];
      return [`${name(el)} (to ${Math.round(right)})`];
    });
    return {
      scroll: document.documentElement.scrollWidth - width,
      wide,
      spill,
    };
  });
}

async function noOverflow(page: Page, screen: string) {
  await settled(page);
  expect(await overflow(page), screen).toEqual({
    scroll: 0,
    wide: [],
    spill: [],
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`long names and notes wrap on a narrow screen (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      ...testInfo.project.use,
      colorScheme,
      // The width of a small phone.
      viewport: { width: 360, height: 740 },
    });
    const page = await context.newPage();
    const endpoint = await fakePushBrowser(page, { subscribed: false });
    try {
      await signIn(page);
      const { listId, listName, names } = await seed(page);
      const device = word("Longdevice", 60);
      await saveFakeSubscription(page, endpoint, device);

      // The list index.
      await page.reload();
      await expect(
        page.getByRole("link", { name: new RegExp(listName) }).first(),
      ).toBeVisible();
      await noOverflow(page, `list index (${colorScheme})`);

      // The list: the rows, and the rows in "Older items".
      await page.goto(`/lists/${listId}`);
      await expect(
        page.getByRole("heading", { level: 1, name: listName }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("region", { name: copy.list.olderItems })
          .getByRole("checkbox"),
      ).toHaveCount(1);
      await noOverflow(page, `list (${colorScheme})`);

      // The notes show in full: no ellipsis.
      const notes = page
        .getByRole("checkbox", { name: new RegExp(`^${names.sentence}`) })
        .getByText(/family size/);
      expect(
        await notes.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);

      // The suggestions of the add bar.
      const box = page.getByRole("combobox", { name: copy.addBar.name });
      await box.fill(names.older.slice(0, 20));
      await expect(
        page
          .getByRole("listbox", { name: copy.addBar.suggestions })
          .getByRole("option", { name: names.older }),
      ).toBeVisible();
      await noOverflow(page, `suggestions (${colorScheme})`);

      // The prompt for a name that is on the list.
      await box.fill(names.url);
      await box.press("Escape");
      await box.press("Enter");
      const prompt = dialog(page, copy.addBar.duplicateTitle(names.url));
      await expect(
        prompt.getByRole("button", { name: copy.addBar.duplicateConfirm }),
      ).toBeVisible();
      await noOverflow(page, `duplicate prompt (${colorScheme})`);
      await prompt.getByRole("button", { name: copy.common.cancel }).click();
      await expect(
        prompt.getByRole("button", { name: copy.addBar.duplicateConfirm }),
      ).toBeHidden();

      // The item sheet.
      await itemAction(page, names.url, copy.item.edit);
      const sheet = dialog(page, copy.itemSheet.title);
      await expect(sheet.getByLabel(copy.itemSheet.notes)).toBeVisible();
      await noOverflow(page, `item sheet (${colorScheme})`);
      await sheet.getByRole("button", { name: copy.common.cancel }).click();
      await expect(sheet).toBeHidden();

      // The Move dialog: its title has the long name (#131).
      await itemAction(page, names.url, copy.item.move);
      const picker = page.getByRole("dialog", {
        name: copy.item.moveTitle(names.url),
      });
      await expect(picker).toBeVisible();
      await noOverflow(page, `move dialog (${colorScheme})`);
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      // The toast after a delete.
      await itemAction(page, names.url, copy.common.delete);
      await expect(
        page
          .locator("wa-toast-item")
          .filter({ hasText: copy.item.deleted(names.url) }),
      ).toBeVisible();
      await noOverflow(page, `toast (${colorScheme})`);

      // Settings: the devices and the lists.
      await page.goto("/settings");
      await expect(
        page.getByRole("switch", { name: copy.settings.listSwitch(listName) }),
      ).toBeAttached();
      await expect(
        page.getByRole("switch", { name: copy.settings.deviceSwitch(device) }),
      ).toBeAttached();
      await noOverflow(page, `settings (${colorScheme})`);
    } finally {
      await removeFakeSubscription(page, endpoint);
      await context.close();
    }
  });
}

/** 20 lists with long names, and an item on the first one (#134). */
async function seedManyLists(page: Page) {
  const clientId = randomUUID();
  let counter = 0;
  const now = Date.now();
  const op = (type: string, args: object) => ({
    opId: randomUUID(),
    clientId,
    hlc: serialize({ wall: now, counter: counter++, node: clientId }),
    type,
    args,
  });
  const lists = Array.from({ length: 20 }, (_, i) => ({
    id: randomUUID(),
    name: `${word(`Store${String(i + 1).padStart(2, "0")}`, 60)}`,
  }));
  const itemName = `Crackers ${randomUUID().slice(0, 8)}`;
  const ops = [
    ...lists.map((l) => op("createList", { listId: l.id, name: l.name })),
    op("addItem", {
      itemId: randomUUID(),
      listId: lists[0].id,
      name: itemName,
    }),
  ];
  const res = await page.request.post("/api/sync/push", {
    data: { clientId, ops },
  });
  expect(res.status()).toBe(200);
  return { lists, itemName };
}

/** The box of an element in the shadow root of the first match. */
function shadowBox(page: Page, host: string, selector: string) {
  return page
    .locator(host)
    .first()
    .evaluate((el, selector) => {
      const part = el.shadowRoot!.querySelector(selector)!;
      const rect = part.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        scrolls: part.scrollHeight > part.clientHeight,
      };
    }, selector);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`the Move dialog fits a small phone with 20 lists (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    const height = 640;
    const context = await browser.newContext({
      ...testInfo.project.use,
      colorScheme,
      viewport: { width: 360, height },
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      const { lists, itemName } = await seedManyLists(page);
      await page.goto(`/lists/${lists[0].id}`);
      await itemAction(page, itemName, copy.item.move);
      const picker = dialog(page, copy.item.moveTitle(itemName));
      const select = picker.getByRole("combobox", { name: copy.item.targets });
      // The select has the focus when the dialog opens.
      await expect(select).toBeFocused();
      await noOverflow(page, `move dialog, many lists (${colorScheme})`);
      // The dialog is short: no list buttons, and it is in the screen.
      const box = await shadowBox(page, "wa-dialog[open]", "dialog");
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(height);

      // The listbox opens in the screen, and scrolls to each list.
      await select.click();
      const last = lists.at(-1)!.name;
      const option = picker.getByRole("option", { name: last, exact: true });
      await expect(
        picker.getByRole("option", { name: lists[1].name, exact: true }),
      ).toBeVisible();
      await noOverflow(page, `move select, many lists (${colorScheme})`);
      const listbox = await shadowBox(page, "wa-select[open]", ".listbox");
      expect(listbox.top).toBeGreaterThanOrEqual(0);
      expect(listbox.bottom).toBeLessThanOrEqual(height);
      expect(listbox.scrolls).toBe(true);
      await expect(
        picker.getByRole("option", { name: lists[0].name, exact: true }),
      ).toHaveCount(0);
      await option.click();
      await expect(select).toHaveValue(last);
      await picker.getByRole("button", { name: copy.item.move }).click();
      await expect(picker).toBeHidden();
      await expect(
        page
          .locator("wa-toast-item")
          .filter({ hasText: copy.item.moved(itemName, last) }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
