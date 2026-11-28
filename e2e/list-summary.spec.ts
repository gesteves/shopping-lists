// The list summary on the lists page (#143): an old summary never shows.
// While a summary for the items now is on the way, the line is a skeleton.
// The e2e server has no ANTHROPIC_API_KEY, thus it makes no summaries: the
// test adds them to the pull responses, as the summary worker would.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { summaryKeyOf, type SummaryItem } from "../src/shared/summary";
import type { ListRecord, PullResponse } from "../src/shared/sync";
import {
  createList,
  listIndex,
  openList,
  scan,
  signIn,
  synced,
} from "./helpers";

async function add(page: Page, name: string) {
  await page.getByLabel(copy.addBar.name).fill(name);
  await page
    .getByRole("button", { name: copy.addBar.add, exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: new RegExp(`^${name}\\b`) }),
  ).toBeVisible();
}

/** Each pull says that the server makes summaries, with this one for the list. */
async function serveSummary(page: Page, listName: string) {
  const state: { text: string; key: string } = { text: "", key: "" };
  let row: ListRecord | undefined;
  await page.route("**/api/sync/pull**", async (route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as PullResponse;
      row = body.lists.find((l) => l.name === listName) ?? row;
      const lists = body.lists.filter((l) => l.name !== listName);
      if (row) {
        lists.push({ ...row, summary: state.text, summaryKey: state.key });
      }
      await route.fulfill({
        response,
        json: { ...body, lists, summaries: true },
      });
    } catch {
      // A navigation stopped the pull: the page that sent it is gone.
    }
  });
  return async (text: string, items: SummaryItem[]) => {
    state.text = text;
    state.key = await summaryKeyOf(items);
  };
}

const one = (name: string): SummaryItem => ({ name, quantity: 1 });

/**
 * The place of the summary line in a row: its distance below the list
 * name, its height, and its left edge.
 */
function lineBox(row: Locator) {
  return row.evaluate((link) => {
    const title = link.firstElementChild!.getBoundingClientRect();
    const line = link
      .querySelector("[data-summary-line]")!
      .getBoundingClientRect();
    return {
      gap: line.top - title.bottom,
      height: line.height,
      left: line.left - title.left,
    };
  });
}

// WebKit does not route the requests of a page that a service worker
// controls, also when the worker lets them go to the network.
test.use({ serviceWorkers: "block" });

test("an old summary is never shown; a skeleton waits for the new one", async ({
  page,
}) => {
  await signIn(page);
  const name = `Summary ${randomUUID().slice(0, 8)}`;
  const setSummary = await serveSummary(page, name);
  await setSummary("Milk and eggs", [one("Milk"), one("Eggs")]);

  await createList(page, name);
  await openList(page, name);
  await add(page, "Milk");
  await add(page, "Eggs");
  await synced(page);

  // The summary is for the items now.
  await page.goto("/");
  const row = listIndex(page).getByRole("link", {
    name: new RegExp(`^${name}`),
  });
  await expect(row).toContainText("Milk and eggs");
  await expect(row.locator("wa-skeleton")).toHaveCount(0);

  // A new item: the summary is old. A skeleton, not the old summary.
  await openList(page, name);
  await add(page, "Bread");
  await synced(page);
  await page.goto("/");
  await expect(row.locator("wa-skeleton")).toBeVisible();
  await expect(row).toContainText(copy.lists.summaryPending);
  await expect(row).not.toContainText("Milk and eggs");
  const skeletonBox = await lineBox(row);

  // It pulses, but not with reduced motion. Then axe, in light and dark.
  const running = () =>
    row
      .locator("wa-skeleton")
      .evaluate(
        (el) =>
          el.shadowRoot
            ?.getAnimations()
            .filter((a) => a.playState === "running").length ?? 0,
      );
  await expect.poll(running).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(running).toBe(0);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await scan(page, `summary skeleton (${colorScheme})`);
  }

  // The new summary comes.
  await setSummary("Milk, eggs, and bread", [
    one("Milk"),
    one("Eggs"),
    one("Bread"),
  ]);
  await page.reload();
  await expect(row).toContainText("Milk, eggs, and bread");
  await expect(row.locator("wa-skeleton")).toHaveCount(0);
  // The summary of one line is at the place of the skeleton: no shift.
  expect(await lineBox(row)).toEqual(skeletonBox);
});
