import { expect, test } from "@playwright/test";

test("the home page shows the placeholder", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Shopping Lists");
  await expect(
    page.getByRole("heading", { name: "Shopping Lists" }),
  ).toBeVisible();
});
