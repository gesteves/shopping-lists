import Database from "better-sqlite3";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL, E2E_DATABASE_PATH } from "../playwright.config";
import { copy } from "../src/copy";

/** Sign in through the stub, as Google would. */
function stubSignIn(page: Page, email: string, name = "Emily") {
  const params = new URLSearchParams({ email, name });
  return page.goto(`/api/auth/e2e/sign-in?${params}`);
}

function userCount(email: string): number {
  const db = new Database(E2E_DATABASE_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM users WHERE email = ?")
      .get(email) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

test("a signed-out page request goes to /sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
});

test(
  "a signed-out API request gets 401",
  { tag: "@once" },
  async ({ request }) => {
    const res = await request.get("/api/lists");
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  },
);

test("an allowlisted account signs in and out", async ({ page }) => {
  await stubSignIn(page, E2E_ALLOWED_EMAIL);
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("img", { name: copy.header.signedInAs("Emily") }),
  ).toBeVisible();

  // A signed-in user does not see the sign-in page.
  await page.goto("/sign-in");
  await expect(page).toHaveURL("/");

  await page.getByRole("link", { name: copy.header.settings }).click();
  await page.getByRole("button", { name: copy.settings.signOut }).click();
  await expect(page).toHaveURL("/sign-in");
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
});

test("an account not in the allowlist is rejected", async ({
  page,
}, testInfo) => {
  const email = `rejected-${testInfo.project.name}@example.com`;
  await stubSignIn(page, email);
  await expect(page).toHaveURL("/sign-in?error=email_not_allowed");
  await expect(
    page.getByRole("alert").filter({ hasText: copy.signIn.emailNotAllowed }),
  ).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in");
  expect(userCount(email)).toBe(0);
});
