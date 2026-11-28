import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";

const META = /<meta name="color-scheme" content="light dark"\s*\/?>/;

async function signIn(page: Page) {
  const params = new URLSearchParams({ email: E2E_ALLOWED_EMAIL, name: "Ana" });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");
}

function colors(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { background: style.backgroundColor, text: style.color };
  });
}

test("the server-rendered HTML declares light and dark", async ({ page }) => {
  const signIn = await page.request.get("/sign-in");
  expect(await signIn.text()).toMatch(META);

  const params = new URLSearchParams({ email: E2E_ALLOWED_EMAIL, name: "Ana" });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  const home = await page.request.get("/");
  expect(home.url()).not.toContain("/sign-in");
  const html = await home.text();
  expect(html).toMatch(META);
  // One theme color for each scheme.
  expect(html).toMatch(
    /name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"|media="\(prefers-color-scheme: light\)"[^>]*name="theme-color"/,
  );
  expect(html).toMatch(/media="\(prefers-color-scheme: dark\)"/);
});

test("light and dark have different colors and pass the contrast scan", async ({
  browser,
}, testInfo) => {
  const seen: Record<string, { background: string; text: string }> = {};
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      for (const route of ["sign-in", "home"] as const) {
        if (route === "sign-in") await page.goto("/sign-in");
        else await signIn(page);

        const now = await colors(page);
        if (route === "sign-in") seen[colorScheme] = now;
        expect(
          await page.evaluate(
            () => getComputedStyle(document.documentElement).colorScheme,
          ),
        ).toBe("light dark");

        const scan = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        expect(
          scan.violations.filter((v) => v.id === "color-contrast"),
          `${colorScheme} ${route}`,
        ).toEqual([]);

        const shot = testInfo.outputPath(`${route}-${colorScheme}.png`);
        // Not the full page: the e2e tests share the lists, thus the list
        // page gets long. On the phone (3x), it was more than the limit of
        // 32767 pixels.
        await page.screenshot({ path: shot });
        await testInfo.attach(`${route}-${colorScheme}`, {
          path: shot,
          contentType: "image/png",
        });
      }
    } finally {
      await context.close();
    }
  }
  expect(seen.light.background).not.toBe(seen.dark.background);
  expect(seen.light.text).not.toBe(seen.dark.text);
});
