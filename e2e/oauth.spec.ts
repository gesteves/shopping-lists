// The OAuth flow of an MCP client in a browser (#18): sign-in, the consent
// page, the redirect with the code, and "Connected apps" in settings.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { copy } from "../src/copy";
import { dialog, mcpCall, signIn } from "./helpers";

// Nothing listens on this port: page.route answers for it. (Not a port that
// browsers block, such as 9.)
const REDIRECT = "http://127.0.0.1:59999/callback";

/** Registers a client as an MCP client does: no cookies. */
async function registerClient(request: APIRequestContext) {
  const name = `Test Claude ${randomUUID().slice(0, 8)}`;
  const res = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      application_type: "native",
    },
  });
  expect(res.status()).toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  return { name, clientId: client_id };
}

function authorizePath(clientId: string, baseURL: string) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "lists:read lists:write offline_access",
    state: "e2e-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  });
  return { path: `/api/auth/oauth2/authorize?${params}`, verifier };
}

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
      redirect_uri: REDIRECT,
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

test("/mcp needs a token, and gives 405 for GET", async ({ request }) => {
  const res = await request.post("/mcp", { data: {} });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toContain(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect((await request.get("/mcp")).status()).toBe(405);
  const meta = await request.get("/.well-known/oauth-authorization-server");
  expect(meta.status()).toBe(200);
});

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
