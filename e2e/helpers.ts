import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ALLOWED_EMAIL } from "../playwright.config";
import { copy } from "../src/copy";

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

/**
 * The list index. Next.js keeps the last page hidden in the DOM, thus find
 * only a visible one.
 */
export function listIndex(page: Page) {
  return page
    .getByRole("region", { name: copy.lists.heading })
    .filter({ visible: true });
}

// All tests use the same lists, and parallel tests add lists at the same
// time. Thus the rows and the Create button can move between the scroll and
// the click of Playwright, and the click hits a different element. Thus
// these helpers use the Enter key, not a click.

/** Make a list on the index, then wait for its row. */
export async function createList(page: Page, name: string) {
  const field = listIndex(page).getByLabel(copy.lists.newName);
  await field.fill(name);
  await field.press("Enter");
  await expect(listIndex(page).getByRole("link", { name })).toBeVisible();
}

/** Open a list from the index, then wait for its page. */
export async function openList(page: Page, name: string) {
  await listIndex(page).getByRole("link", { name }).press("Enter");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

/**
 * Open the menu of a list on the index, then select an item. The click
 * events go to the elements with no hit test, because the rows can move.
 */
export async function listAction(page: Page, name: string, action: string) {
  await listIndex(page)
    .getByRole("button", { name: copy.lists.more(name) })
    .dispatchEvent("click");
  const item = listIndex(page).getByRole("menuitem", { name: action });
  await expect(item).toBeVisible();
  await item.dispatchEvent("click");
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
 * hidden input in its shadow root: check its state, but click this. Next.js
 * keeps the last page hidden in the DOM, thus find only a visible one.
 */
export function switchControl(page: Page, name: string) {
  return page
    .locator("wa-switch")
    .filter({ visible: true })
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

/** A valid P-256 public key and auth secret, so web-push can encrypt. */
const FAKE_KEYS = {
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

/**
 * A browser with fake push (#98), for each page load of `page`: the
 * permission, PushManager, and `navigator.standalone = true` (so WebKit on
 * an iPhone is not "needs-install"). With `subscribed`, this browser has a
 * subscription from the start; else `subscribe()` makes it. The endpoint is
 * a loopback URL that refuses each push. Call it before the first `goto`.
 */
export async function fakePushBrowser(
  page: Page,
  options: { subscribed: boolean },
) {
  const endpoint = `https://127.0.0.1:1/push/${crypto.randomUUID()}`;
  await page.addInitScript(
    ({ endpoint, subscribed, keys }) => {
      const KEY = "e2e-fake-push";
      const state = () =>
        localStorage.getItem(KEY) ?? (subscribed ? "subscribed" : "none");
      Object.defineProperty(navigator, "standalone", { get: () => true });
      if (!("Notification" in window)) return;
      Object.defineProperty(Notification, "permission", {
        get: () => (state() === "none" ? "default" : "granted"),
      });
      Notification.requestPermission = async () => {
        if (state() === "none") localStorage.setItem(KEY, "granted");
        return "granted";
      };
      if (!("PushManager" in window)) return;
      const subscription = {
        endpoint,
        expirationTime: null,
        toJSON: () => ({ endpoint, expirationTime: null, keys }),
        unsubscribe: async () => {
          localStorage.setItem(KEY, "granted");
          return true;
        },
      };
      PushManager.prototype.getSubscription = async () =>
        (state() === "subscribed" ? subscription : null) as never;
      PushManager.prototype.subscribe = async () => {
        localStorage.setItem(KEY, "subscribed");
        return subscription as never;
      };
    },
    { endpoint, subscribed: options.subscribed, keys: FAKE_KEYS },
  );
  return endpoint;
}

/** Save a push subscription for the signed-in user. It returns its ID. */
export async function saveFakeSubscription(
  page: Page,
  endpoint: string,
  deviceLabel: string,
): Promise<string> {
  const res = await page.request.post("/api/push/subscriptions", {
    data: { endpoint, keys: FAKE_KEYS, deviceLabel },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).subscription.id;
}

/** Remove the push subscriptions with this endpoint (all tests share a user). */
export async function removeFakeSubscription(page: Page, endpoint: string) {
  const res = await page.request.get("/api/push/subscriptions");
  const { subscriptions } = (await res.json()) as {
    subscriptions: { id: string; endpoint: string }[];
  };
  for (const s of subscriptions.filter((s) => s.endpoint === endpoint)) {
    await page.request.delete(`/api/push/subscriptions/${s.id}`);
  }
}

/**
 * Run axe (WCAG 2.2 A and AA) on the page, after the Web Awesome components
 * are defined and their animations end. No serious or critical issues.
 */
export async function scan(page: Page, screen: string) {
  // Wait for the Web Awesome components: undefined tags are hidden.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("*")].every(
      (el) =>
        !el.localName.startsWith("wa-") || customElements.get(el.localName),
    ),
  );
  // Colors in the middle of a fade-in are not the real colors.
  // Web Awesome animates in its shadow roots, which document.getAnimations()
  // does not include.
  await page.waitForFunction(() =>
    [
      document,
      ...[...document.querySelectorAll("*")].flatMap((el) =>
        el.shadowRoot ? [el.shadowRoot] : [],
      ),
    ].every((root) =>
      root.getAnimations().every((a) => a.playState !== "running"),
    ),
  );
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target} (${n.any.map((c) => c.message).join("; ")})`)
          .join(" | ")}`,
    ),
    screen,
  ).toEqual([]);
}
