// The OAuth flow of an MCP client in a browser (#18): sign-in, the consent
// page, the redirect with the code, and "Connected apps" in settings.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { copy } from "../src/copy";
import {
  authorizePath,
  dialog,
  mcpCall,
  OAUTH_REDIRECT,
  registerClient,
  signIn,
} from "./helpers";

test("connect an app, then disconnect it in settings", async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page);
  const { name, clientId } = await registerClient(request);
  const callbacks: URL[] = [];
  await page.route("http://127.0.0.1:59999/**", (route) => {
    callbacks.push(new URL(route.request().url()));
    return route.fulfill({ body: "The app got the code." });
  });

  const { path, verifier } = authorizePath(clientId, baseURL!);
  await page.goto(path);
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
  await expect(
    page.getByRole("heading", { name: copy.consent.heading(name) }),
  ).toBeVisible();
  await expect(
    page.getByText("127.0.0.1:59999", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(copy.consent.loopback)).toBeVisible();
  await expect(page.getByText(copy.consent.scopes.read)).toBeVisible();
  // A DCR client has no host to check.
  await expect(
    page.getByText(copy.consent.unverified, { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: copy.consent.connect, exact: true })
    .click();
  await expect.poll(() => callbacks.length).toBe(1);
  const callback = callbacks[0];
  expect(callback.searchParams.get("state")).toBe("e2e-state");
  expect(callback.searchParams.get("iss")).toBe(baseURL);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  // The client gets its tokens.
  const tokens = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: OAUTH_REDIRECT,
      code_verifier: verifier,
      client_id: clientId,
      resource: `${baseURL}/mcp`,
    },
  });
  expect(tokens.status()).toBe(200);
  const { access_token } = (await tokens.json()) as { access_token: string };
  const mcp = (token: string) => mcpCall(request, token, "tools/list");
  expect((await mcp(access_token)).status()).toBe(200);

  // Disconnect it.
  await page.goto("/settings");
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: `${copy.settings.disconnect} ${name}` })
    .click();
  const confirm = dialog(page, copy.settings.disconnectTitle(name));
  await confirm.getByRole("button", { name: copy.settings.disconnect }).click();
  // The toast, not its copy in the screen reader live region.
  await expect(
    page
      .locator("wa-toast-item")
      .filter({ hasText: copy.settings.disconnected(name) }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);

  // The token that worked a moment ago does not work now.
  const after = await mcp(access_token);
  expect(after.status()).toBe(401);
  expect(after.headers()["www-authenticate"]).toContain("resource_metadata=");
});

test(
  "/mcp needs a token, and gives 405 for GET",
  { tag: "@once" },
  async ({ request }) => {
    const res = await request.post("/mcp", { data: {} });
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
    expect((await request.get("/mcp")).status()).toBe(405);
    const meta = await request.get("/.well-known/oauth-authorization-server");
    expect(meta.status()).toBe(200);
  },
);

test("the consent page passes the contrast scan in light and dark", async ({
  browser,
  request,
  baseURL,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    try {
      await signIn(page);
      const { clientId } = await registerClient(request);
      await page.goto(authorizePath(clientId, baseURL!).path);
      await expect(
        page.getByRole("button", { name: copy.consent.connect, exact: true }),
      ).toBeVisible();
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(scan.violations, colorScheme).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
