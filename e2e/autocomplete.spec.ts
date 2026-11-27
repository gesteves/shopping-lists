import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import { dialog, signIn, synced } from "./helpers";

function index(page: Page) {
  return page
    .getByRole("region", { name: copy.lists.heading })
    .filter({ visible: true });
}

async function newList(page: Page, prefix: string) {
  const name = `${prefix} ${randomUUID().slice(0, 8)}`;
  await index(page).getByLabel(copy.lists.newName).fill(name);
  await index(page).getByRole("button", { name: copy.lists.create }).click();
  await expect(index(page).getByRole("link", { name })).toBeVisible();
  return name;
}

async function open(page: Page, name: string) {
  await index(page).getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

function item(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

async function add(page: Page, name: string) {
  await page.getByRole("combobox", { name: copy.addBar.name }).fill(name);
  await page.getByRole("combobox", { name: copy.addBar.name }).press("Enter");
}

test("typing suggests past items from every list", async ({ page }) => {
  await signIn(page);
  // A rare name, so other tests do not change the order.
  const word = `Kohlrabi${randomUUID().slice(0, 4)}`;
  const first = await newList(page, "Past");
  await open(page, first);
  await add(page, `${word} purple`);
  await expect(item(page, `${word} purple`)).toBeVisible();

  await page.goto("/");
  const second = await newList(page, "Next");
  await open(page, second);
  const box = page.getByRole("combobox", { name: copy.addBar.name });
  await box.fill(word.toLowerCase());
  const options = page.getByRole("listbox", { name: copy.addBar.suggestions });
  await expect(
    options.getByRole("option", { name: `${word} purple` }),
  ).toBeVisible();

  // The keyboard picks a suggestion.
  await box.press("ArrowDown");
  await expect(
    options.getByRole("option", { name: `${word} purple` }),
  ).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(item(page, `${word} purple`)).toBeVisible();
  await expect(box).toHaveValue("");
});

test("a name already on the list asks first", async ({ page }) => {
  await signIn(page);
  const name = await newList(page, "Dupes");
  await open(page, name);
  await add(page, "Butter");
  await expect(item(page, "Butter")).toBeVisible();

  // Unchecked: offer one more.
  await add(page, "butter");
  const more = dialog(page, copy.addBar.duplicateTitle("Butter"));
  await more
    .getByRole("button", { name: copy.addBar.duplicateConfirm })
    .click();
  await expect(item(page, "Butter")).toContainText(copy.item.quantity(2));

  // Checked: offer to uncheck it.
  await item(page, "Butter").click();
  await expect(item(page, "Butter")).toHaveAttribute("aria-checked", "true");
  await add(page, "Butter");
  await dialog(page, copy.addBar.checkedTitle("Butter"))
    .getByRole("button", { name: copy.addBar.checkedConfirm })
    .click();
  await expect(item(page, "Butter")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("checkbox", { name: /^Butter/ })).toHaveCount(1);
});

test("two people adding the same name make one row", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a);
    await signIn(b, E2E_SECOND_EMAIL, "Ben");
    const name = await newList(a, "Race");
    await synced(a);
    await open(a, name);
    // Realtime has its own test. Here a reload gets the list.
    await b.reload();
    await open(b, name);

    // Both add before either one syncs.
    await Promise.all([add(a, "Avocados"), add(b, "avocados")]);
    await synced(a);
    await synced(b);
    await a.reload();
    await b.reload();
    await expect(a.getByRole("checkbox", { name: /^avocados/i })).toHaveCount(
      1,
    );
    await expect(b.getByRole("checkbox", { name: /^avocados/i })).toHaveCount(
      1,
    );
    const pull = await a.request.get("/api/sync/pull?since=0");
    const listId = new URL(a.url()).pathname.split("/").at(-1);
    const rows = (await pull.json()).items.filter(
      (i: { name: string; listId: string; deletedAt: number | null }) =>
        i.listId === listId &&
        i.name.toLowerCase() === "avocados" &&
        i.deletedAt === null,
    );
    expect(rows).toHaveLength(1);
  } finally {
    await a.close();
    await b.close();
  }
});
