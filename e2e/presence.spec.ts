import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import { createList, openList, signIn, synced, itemAction } from "./helpers";

test("each person sees what the other has open and is editing", async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a);
    await signIn(b, E2E_SECOND_EMAIL, "Haley");

    // A makes a list with one item. B gets it through realtime.
    const name = `Presence ${randomUUID().slice(0, 8)}`;
    await createList(a, name);
    await openList(a, name);
    await a.getByLabel(copy.addBar.name).fill("Milk");
    await a.getByLabel(copy.addBar.name).press("Enter");
    await synced(a);

    const indexB = b
      .getByRole("region", { name: copy.lists.heading })
      .filter({ visible: true });
    const rowB = indexB.getByRole("listitem").filter({ hasText: name });
    await expect(rowB).toBeVisible();

    // A has the list open: B sees a dot on the row.
    const dot = rowB.getByRole("img", { name: copy.presence.viewing("Emily") });
    await expect(dot).toBeVisible({ timeout: 2000 });

    // A edits the item: B sees the badge in the list.
    await openList(b, name);
    await itemAction(a, "Milk", copy.item.edit);
    const badge = b
      .getByRole("checkbox", { name: /^Milk/ })
      .getByText(copy.item.editing(["Emily"]));
    await expect(badge).toBeVisible({ timeout: 2000 });

    // A closes the sheet, then leaves the list.
    await a.keyboard.press("Escape");
    await expect(badge).toBeHidden({ timeout: 2000 });
    // Leave in the app, as a person does.
    await a.getByRole("link", { name: copy.app.name }).click();
    await expect(a).toHaveURL("/");
    await b.getByRole("link", { name: copy.app.name }).click();
    // Only this row: other tests also sign in as Emily.
    const row = b
      .getByRole("region", { name: copy.lists.heading })
      .filter({ visible: true })
      .getByRole("listitem")
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("img", { name: copy.presence.viewing("Emily") }),
    ).toHaveCount(0, { timeout: 2000 });
  } finally {
    await a.close();
    await b.close();
  }
});

test(
  "a closed page goes away within the TTL",
  { tag: "@once" },
  async ({ browser }) => {
    // Only on desktop: the TTL is on the server, and the wait is long.
    test.slow();
    const a = await browser.newPage();
    const b = await browser.newPage();
    try {
      await signIn(a);
      await signIn(b, E2E_SECOND_EMAIL, "Haley");
      const name = `Gone ${randomUUID().slice(0, 8)}`;
      await createList(a, name);
      await openList(a, name);
      await synced(a);
      const dot = b
        .getByRole("region", { name: copy.lists.heading })
        .filter({ visible: true })
        .getByRole("listitem")
        .filter({ hasText: name })
        .getByRole("img", { name: copy.presence.viewing("Emily") });
      await expect(dot).toBeVisible();

      // No clear message: the page just goes. The 30 s TTL removes it.
      await a.close({ runBeforeUnload: false });
      await expect(dot).toHaveCount(0, { timeout: 40_000 });
    } finally {
      await b.close();
    }
  },
);
