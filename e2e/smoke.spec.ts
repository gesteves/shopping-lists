import { expect, test } from "@playwright/test";
import { copy } from "../src/copy";

test("the sign-in page loads", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page).toHaveTitle(copy.app.pageTitle(copy.signIn.title));
  await expect(
    page.getByRole("heading", { name: copy.app.name }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.signIn.button }),
  ).toBeVisible();
});

test("the health check needs no session", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("the Home Screen files need no session", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(await manifest.json()).toMatchObject({ display: "standalone" });

  for (const path of ["/apple-icon.png", "/icon-192.png", "/icon-512.png"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toBe("image/png");
  }
});
