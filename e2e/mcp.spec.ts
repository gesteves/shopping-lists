// MCP changes in the app (#19): a change that Claude makes for one person
// appears live for the other person, marked "via Claude".
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_SECOND_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";
import {
  createList,
  mcpCall,
  openList,
  signIn,
  synced,
  itemAction,
} from "./helpers";

const REDIRECT = "http://127.0.0.1:59999/callback";

/**
 * Connects a new MCP client for the person signed in on `page`. `request`
 * must have no cookies, as a real client: it registers and gets the token.
 */
async function connectClaude(
  page: Page,
  request: APIRequestContext,
  baseURL: string,
): Promise<string> {
  const reg = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      application_type: "native",
    },
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    scope: "lists:read lists:write offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: `${baseURL}/mcp`,
  });
  let code = "";
  await page.route("http://127.0.0.1:59999/**", (route) => {
    code = new URL(route.request().url()).searchParams.get("code") ?? "";
    return route.fulfill({ body: "ok" });
  });
  await page.goto(`/api/auth/oauth2/authorize?${params}`);
  await page
    .getByRole("button", { name: copy.consent.connect, exact: true })
    .click();
  await expect.poll(() => code).not.toBe("");
  const tokens = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id,
      resource: `${baseURL}/mcp`,
    },
  });
  return ((await tokens.json()) as { access_token: string }).access_token;
}

/** Calls a tool, and checks that it worked. */
async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await mcpCall(request, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    result: { isError?: boolean; structuredContent: unknown };
  };
  expect(body.result.isError).toBeFalsy();
  return body.result.structuredContent;
}

test("a change through Claude appears live, marked via Claude", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  // Emily has the list open.
  await signIn(page);
  const list = `MCP ${randomUUID().slice(0, 8)}`;
  await createList(page, list);
  await openList(page, list);
  // The list must be on the server before Claude can find it.
  await synced(page);

  // Haley asks their Claude to add two items.
  const haley = await browser.newContext();
  try {
    const haleyPage = await haley.newPage();
    await signIn(haleyPage, E2E_SECOND_EMAIL, "Haley");
    const token = await connectClaude(haleyPage, request, baseURL!);
    await callTool(request, token, "add_items", {
      list: list.toLowerCase(),
      items: [{ name: "Oat milk" }, { name: "Eggs", quantity: 12 }],
    });
  } finally {
    await haley.close();
  }

  // Emily sees them without a reload, marked via Claude.
  const oat = page.getByRole("checkbox", { name: /^Oat milk\b/ });
  await expect(oat).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("checkbox", { name: /^Eggs\b/ })).toBeVisible();
  await itemAction(page, "Oat milk", copy.item.edit);
  await expect(
    page.getByText(
      copy.item.updated(copy.people.viaClaude("Haley"), copy.time.justNow),
      { exact: true },
    ),
  ).toBeVisible();
});
