import { expect, test } from "@playwright/test";

test("the sign-in page loads", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page).toHaveTitle("Sign in – Shopping Lists");
  await expect(
    page.getByRole("heading", { name: "Shopping Lists" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
});
