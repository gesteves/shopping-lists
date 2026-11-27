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
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
});

test(
  "robots.txt needs no session and stops all crawlers",
  { tag: "@once" },
  async ({ request }) => {
    const res = await request.get("/robots.txt", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    const lines = (await res.text()).split("\n").map((l) => l.trim());
    expect(lines).toContain("User-Agent: *");
    expect(lines).toContain("Disallow: /");
  },
);

test(
  "the health check needs no session",
  { tag: "@once" },
  async ({ request }) => {
    for (const path of ["/api/health", "/api/health/live"]) {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
  },
);

test(
  "the Home Screen files need no session",
  { tag: "@once" },
  async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect(await manifest.json()).toMatchObject({ display: "standalone" });

    for (const path of ["/apple-icon.png", "/icon-192.png", "/icon-512.png"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toBe("image/png");
    }
  },
);

test(
  "each response has the security headers",
  { tag: "@once" },
  async ({ request }) => {
    for (const path of [
      "/sign-in",
      "/api/health",
      "/oauth/consent",
      "/sw.js",
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      const headers = res.headers();
      expect(headers["x-frame-options"], path).toBe("DENY");
      expect(headers["content-security-policy"], path).toBe(
        "frame-ancestors 'none'",
      );
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["referrer-policy"], path).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(headers["strict-transport-security"], path).toContain("max-age=");
      expect(headers["permissions-policy"], path).toContain("camera=()");
      expect(headers["x-powered-by"], path).toBeUndefined();
    }
  },
);
