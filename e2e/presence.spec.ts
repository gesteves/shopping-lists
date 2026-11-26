import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { signIn, synced } from "./helpers";

test("each person sees what the other has open and is editing", async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a);
    await signIn(b, E2E_SECOND_EMAIL, "Ben");

    // A makes a list with one item. B gets it through realtime.
    const name = `Presence ${randomUUID().slice(0, 8)}`;
    const indexA = a
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true });
    await indexA.getByLabel("New list name").fill(name);
    await indexA.getByRole("button", { name: "Create" }).click();
    await indexA.getByRole("link", { name }).click();
    await a.getByLabel("Item name").fill("Milk");
    await a.getByLabel("Item name").press("Enter");
    await synced(a);

    const indexB = b
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true });
    const rowB = indexB.getByRole("listitem").filter({ hasText: name });
    await expect(rowB).toBeVisible();

    // A has the list open: B sees a dot on the row.
    const dot = rowB.getByRole("img", { name: "Ana has this list open" });
    await expect(dot).toBeVisible({ timeout: 2000 });

    // A edits the item: B sees the badge in the list.
    await indexB.getByRole("link", { name }).click();
    await a.getByRole("button", { name: "Edit Milk" }).click();
    const badge = b
      .getByRole("checkbox", { name: /^Milk/ })
      .getByText("Ana is editing…");
    await expect(badge).toBeVisible({ timeout: 2000 });

    // A closes the sheet, then leaves the list.
    await a.keyboard.press("Escape");
    await expect(badge).toBeHidden({ timeout: 2000 });
    // Leave in the app, as a person does.
    await a.getByRole("link", { name: "Shopping Lists" }).click();
    await expect(a).toHaveURL("/");
    await b.getByRole("link", { name: "Shopping Lists" }).click();
    // Only this row: other tests also sign in as Ana.
    const row = b
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true })
      .getByRole("listitem")
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("img", { name: "Ana has this list open" }),
    ).toHaveCount(0, { timeout: 2000 });
  } finally {
    await a.close();
    await b.close();
  }
});

test("a closed page goes away within the TTL", async ({ browser }) => {
  test.slow();
  const a = await browser.newPage();
  const b = await browser.newPage();
  try {
    await signIn(a);
    await signIn(b, E2E_SECOND_EMAIL, "Ben");
    const name = `Gone ${randomUUID().slice(0, 8)}`;
    const indexA = a
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true });
    await indexA.getByLabel("New list name").fill(name);
    await indexA.getByRole("button", { name: "Create" }).click();
    await indexA.getByRole("link", { name }).click();
    await synced(a);
    const dot = b
      .getByRole("region", { name: "Lists" })
      .filter({ visible: true })
      .getByRole("listitem")
      .filter({ hasText: name })
      .getByRole("img", { name: "Ana has this list open" });
    await expect(dot).toBeVisible();

    // No clear message: the page just goes. The 30 s TTL removes it.
    await a.close({ runBeforeUnload: false });
    await expect(dot).toHaveCount(0, { timeout: 40_000 });
  } finally {
    await b.close();
  }
});
