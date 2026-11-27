import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";

/** Sign in through the stub, as Google would. */
export async function signIn(
  page: Page,
  email = E2E_ALLOWED_EMAIL,
  name = "Ana",
) {
  const params = new URLSearchParams({ email, name });
  await page.goto(`/api/auth/e2e/sign-in?${params}`);
  await expect(page).toHaveURL("/");
}

/** The number of ops in the local outbox (Dexie database "shopping-lists"). */
export function outboxCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("shopping-lists");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("outbox")) {
            db.close();
            return resolve(0);
          }
          const count = db.transaction("outbox").objectStore("outbox").count();
          count.onsuccess = () => {
            resolve(count.result);
            db.close();
          };
        };
      }),
  );
}

/** Wait until the server has every local change. */
export async function synced(page: Page) {
  await expect.poll(() => outboxCount(page), { timeout: 10_000 }).toBe(0);
}

/**
 * A Web Awesome dialog or drawer, by its label. Scope to the host element:
 * the inner <dialog> (role "dialog") is in the shadow root, and the fields
 * are slotted, thus they are not inside it.
 */
export function dialog(page: Page, name: string | RegExp) {
  return page
    .locator("wa-dialog, wa-drawer")
    .filter({ has: page.getByRole("dialog", { name }) });
}

/**
 * The visible <wa-switch> of a switch, for a click. The role "switch" is a
 * hidden input in its shadow root: check its state, but click this.
 */
export function switchControl(page: Page, name: string) {
  return page
    .locator("wa-switch")
    .filter({ has: page.getByRole("switch", { name }) });
}

/** A JSON-RPC request to /mcp as a 2026-07-28 client, with a token. */
export function mcpCall(
  request: APIRequestContext,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const version = "2026-07-28";
  return request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
      "mcp-method": method,
      ...(typeof params.name === "string" && { "mcp-name": params.name }),
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
}

/** `text` with the RegExp special characters escaped. */
export function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A RegExp for a copy function with a count. It matches the text for all
 * counts: `anyCount(copy.sync.changesToSync)` matches "1 change to sync"
 * and "4 changes to sync".
 */
export function anyCount(text: (n: number) => string): RegExp {
  const forms = [1, 7].map((n) =>
    escapeRegExp(text(n)).replace(String(n), "\\d+"),
  );
  return new RegExp(forms.join("|"));
}
