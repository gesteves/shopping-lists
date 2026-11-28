import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  DAY_MS,
  daysLeft,
  expiresAt,
  expiryVariant,
} from "../src/shared/expiry";
import { serialize } from "../src/shared/hlc";
import { dialog, itemAction, pickList, scan, signIn, synced } from "./helpers";

// Days are local calendar days (#112). The browser and this test use the
// same time zone, so that the expected badges are the same on each machine.
const ZONE = "America/Denver";
process.env.TZ = ZONE;
test.use({ timezoneId: ZONE });

/** Days that are left for each item: brand, warning, danger (tomorrow and today). */
const ITEMS = [
  { name: "Batteries", left: 10 },
  { name: "Foil", left: 5 },
  { name: "Tape", left: 1.2 },
  { name: "Glue", left: 0.05 },
];

/** A list with items that were checked long ago, through the sync API. */
async function seed(page: Page) {
  const clientId = randomUUID();
  const listId = randomUUID();
  const otherId = randomUUID();
  const name = `Expiry ${randomUUID().slice(0, 8)}`;
  const other = `Expiry move ${randomUUID().slice(0, 8)}`;
  const now = Date.now();
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
  const created = now - 40 * DAY_MS;
  const ops = [
    op("createList", { listId, name }, created),
    op("createList", { listId: otherId, name: other }, created),
  ];
  const checks: Record<string, number> = {};
  for (const item of ITEMS) {
    const itemId = randomUUID();
    const checkedAt = now - (30 - item.left) * DAY_MS;
    checks[item.name] = Math.floor(checkedAt);
    ops.push(op("addItem", { itemId, listId, name: item.name }, created));
    ops.push(op("check", { itemId }, checkedAt));
  }
  const res = await page.request.post("/api/sync/push", {
    data: { clientId, ops },
  });
  expect(res.status()).toBe(200);
  return { listId, name, other, checks };
}

function older(page: Page) {
  return page.getByRole("region", { name: copy.list.olderItems });
}

function row(page: Page, name: string) {
  return page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) });
}

test("old checked items show in Older items with a badge, and leave it on a change", async ({
  page,
}) => {
  await signIn(page);
  const { listId, name, other, checks } = await seed(page);
  await page.goto(`/lists/${listId}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // The delete that comes soonest is last.
  const section = older(page);
  await expect(
    section.getByRole("heading", { level: 2, name: copy.list.olderItems }),
  ).toBeVisible();
  await expect
    .poll(() =>
      section
        .getByRole("checkbox")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-name"))),
    )
    .toEqual(ITEMS.map((i) => i.name));

  for (const item of ITEMS) {
    const days = daysLeft(expiresAt(checks[item.name]), Date.now());
    const badge = section
      .getByRole("listitem")
      .filter({ has: row(page, item.name) })
      .locator("wa-badge");
    await expect(badge).toHaveText(copy.item.expiresIn(days));
    await expect(badge).toHaveAttribute("variant", expiryVariant(days));
  }
  // The checks are on the server, thus no change waits.
  await synced(page);

  // Uncheck: back in the main list, with no badge.
  await row(page, "Batteries").click();
  await expect(
    section.getByRole("checkbox", { name: /^Batteries/ }),
  ).toHaveCount(0);
  await expect(row(page, "Batteries")).toHaveAttribute("aria-checked", "false");

  // Edit: it unchecks the item.
  await itemAction(page, "Foil", copy.item.edit);
  const sheet = dialog(page, copy.itemSheet.title);
  await sheet.getByLabel(copy.itemSheet.notes).fill("Heavy duty");
  await sheet.getByRole("button", { name: copy.common.save }).click();
  await expect(sheet).toBeHidden();
  await expect(section.getByRole("checkbox", { name: /^Foil/ })).toHaveCount(0);
  await expect(row(page, "Foil")).toHaveAttribute("aria-checked", "false");

  // Move: it goes to the other list, unchecked.
  await itemAction(page, "Tape", copy.item.move);
  await pickList(page, "move", "Tape", other);
  await expect(row(page, "Tape")).toHaveCount(0);
  await expect(section.getByRole("checkbox")).toHaveCount(1);

  // The server has the same rules: after a sync and a reload, the same.
  await synced(page);
  await page.reload();
  await expect(older(page).getByRole("checkbox")).toHaveCount(1);
  await expect(row(page, "Foil")).toHaveAttribute("aria-checked", "false");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`the expiry badges pass axe (${colorScheme})`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      ...testInfo.project.use,
      colorScheme,
      timezoneId: ZONE,
    });
    const page = await context.newPage();
    try {
      await signIn(page);
      const { listId } = await seed(page);
      await page.goto(`/lists/${listId}`);
      await expect(older(page).getByRole("checkbox")).toHaveCount(ITEMS.length);
      await scan(page, `older items (${colorScheme})`);
    } finally {
      await context.close();
    }
  });
}
