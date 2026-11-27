import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import {
  anyCount,
  createList,
  escapeRegExp,
  fakePushBrowser,
  openList,
  removeFakeSubscription,
  saveFakeSubscription,
  signIn,
  switchControl,
} from "./helpers";

/** A device with a fake push endpoint, saved through the API. */
async function fakeDevice(page: Page) {
  const label = `Test device ${randomUUID().slice(0, 8)}`;
  const res = await page.request.post("/api/push/subscriptions", {
    data: {
      // Refused at once, with no DNS lookup. A lookup that hangs blocks the
      // Node thread pool and slows the whole server. The server accepts a
      // loopback endpoint only with the auth stub (e2e).
      endpoint: `https://127.0.0.1:1/push/${randomUUID()}`,
      keys: {
        // A valid P-256 public key and auth secret, so web-push can encrypt.
        p256dh:
          "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        auth: "tBHItJI5svbpez7KI4CCXg",
      },
      deviceLabel: label,
    },
  });
  expect(res.status()).toBe(201);
  return label;
}

test(
  "the push routes need a session",
  { tag: "@once" },
  async ({ request }) => {
    expect((await request.get("/api/push/subscriptions")).status()).toBe(401);
    expect((await request.post("/api/push/test", { data: {} })).status()).toBe(
      401,
    );
    expect((await request.get("/api/push/mutes")).status()).toBe(401);
  },
);

test("turn a device off and on, send a test, and remove it", async ({
  page,
}) => {
  await signIn(page);
  const label = await fakeDevice(page);
  await page.getByRole("link", { name: copy.header.settings }).click();
  await expect(
    page.getByRole("heading", { name: copy.settings.title }),
  ).toBeVisible();

  const toggleName = copy.settings.deviceSwitch(label);
  const toggle = page.getByRole("switch", { name: toggleName });
  await expect(toggle).toBeChecked();
  // The switch changes at the click, before the server saves. Wait for the
  // save: a reload stops the request.
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes("/api/push/subscriptions/") &&
      r.ok(),
  );
  await switchControl(page, toggleName).click();
  await expect(toggle).not.toBeChecked();
  await saved;
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await switchControl(page, toggleName).click();
  await expect(toggle).toBeChecked();

  // The fake endpoint refuses, so the push does not arrive.
  await page.getByRole("button", { name: copy.settings.sendTest }).click();
  await expect(
    page.locator("wa-toast-item").filter({
      hasText: new RegExp(
        `${anyCount(copy.settings.testSent).source}|${escapeRegExp(copy.settings.testUndelivered)}`,
      ),
    }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: `${copy.settings.remove} ${label}` })
    .click();
  await expect(toggle).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: copy.settings.devices }),
  ).toBeVisible();
  await expect(toggle).toHaveCount(0);
});

/** The response to a mute change, after the server saves it. */
function savedMute(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.url().endsWith("/api/push/mutes") &&
      r.ok(),
  );
}

test("mute and unmute a list", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile",
    "WebKit has no PushManager here: the list switch is hidden.",
  );
  // The list switch shows this device (#98): a subscribed browser.
  const endpoint = await fakePushBrowser(page, { subscribed: true });
  await signIn(page);
  await saveFakeSubscription(page, endpoint, "Mute test device");
  const name = `Mute ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await expect
    .poll(async () => {
      const pull = await page.request.get("/api/sync/pull?since=0");
      return (await pull.json()).lists.some(
        (l: { name: string }) => l.name === name,
      );
    })
    .toBe(true);

  await page.getByRole("link", { name: copy.header.settings }).click();
  const toggleName = copy.settings.listSwitch(name);
  const toggle = page.getByRole("switch", { name: toggleName });
  await expect(toggle).toBeChecked();
  // The switch changes at the click, before the server saves. Wait for the
  // save: a reload stops the request.
  let saved = savedMute(page);
  await switchControl(page, toggleName).click();
  await expect(toggle).not.toBeChecked();
  await saved;
  await page.reload();
  await expect(toggle).not.toBeChecked();
  saved = savedMute(page);
  await switchControl(page, toggleName).click();
  await expect(toggle).toBeChecked();
  await saved;
  await page.reload();
  await expect(toggle).toBeChecked();

  // The list page has the same switch, below the list name (#82).
  await page.goto("/");
  await openList(page, name);
  const listName = copy.list.notifications;
  const listToggle = page.getByRole("switch", { name: listName, exact: true });
  await expect(listToggle).toBeChecked();
  await switchControl(page, listName).click();
  // Muting is for all devices, and a toast tells so.
  await expect(
    page.locator("wa-toast-item", { hasText: copy.list.mutedEverywhere }),
  ).toBeVisible();
  // The switch changes at once. Wait for the server to save the mute.
  const listId = new URL(page.url()).pathname.split("/").pop();
  await expect
    .poll(async () => {
      const res = await page.request.get("/api/push/mutes");
      return (await res.json()).listIds;
    })
    .toContain(listId);
  await page.reload();
  await expect(listToggle).not.toBeChecked();
  await page.getByRole("link", { name: copy.header.settings }).click();
  await expect(toggle).not.toBeChecked();
  await removeFakeSubscription(page, endpoint);
});

/** Make a list on the index and open it. */
async function newList(page: Page, prefix: string) {
  const name = `${prefix} ${randomUUID().slice(0, 8)}`;
  await createList(page, name);
  await openList(page, name);
  return name;
}

/** The Notifications switch of the list page. */
function listSwitch(page: Page) {
  return page.getByRole("switch", {
    name: copy.list.notifications,
    exact: true,
  });
}

/** Wait until the list page knows the devices and the mutes. */
async function switchesLoaded(page: Page, run: () => Promise<unknown>) {
  const devices = page.waitForResponse((r) =>
    r.url().endsWith("/api/push/subscriptions"),
  );
  const mutes = page.waitForResponse((r) =>
    r.url().endsWith("/api/push/mutes"),
  );
  await run();
  await Promise.all([devices, mutes]);
}

test.describe("the list switch shows this device (#98)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "WebKit has no PushManager here.",
  );

  test("no subscription: off, and on turns on push here", async ({ page }) => {
    const endpoint = await fakePushBrowser(page, { subscribed: false });
    await signIn(page);
    try {
      await switchesLoaded(page, () => newList(page, "Push off"));
      await expect(listSwitch(page)).not.toBeChecked();

      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith("/api/push/subscriptions") &&
          r.status() === 201,
      );
      await switchControl(page, copy.list.notifications).click();
      await saved;
      await expect(listSwitch(page)).toBeChecked();
      await page.reload();
      await expect(listSwitch(page)).toBeChecked();
    } finally {
      await removeFakeSubscription(page, endpoint);
    }
  });

  test("a device that is off in Settings: off", async ({ page }) => {
    const endpoint = await fakePushBrowser(page, { subscribed: true });
    await signIn(page);
    try {
      const id = await saveFakeSubscription(page, endpoint, "Off device");
      const off = await page.request.patch(`/api/push/subscriptions/${id}`, {
        data: { enabled: false },
      });
      expect(off.status()).toBe(204);
      await switchesLoaded(page, () => newList(page, "Device off"));
      await expect(listSwitch(page)).not.toBeChecked();
    } finally {
      await removeFakeSubscription(page, endpoint);
    }
  });
});

test("Safari on iPhone outside the Home Screen app: no Notifications switch", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "An iPhone test.");
  await signIn(page);
  await switchesLoaded(page, () => newList(page, "iPhone"));
  await expect(listSwitch(page)).toHaveCount(0);
});

test.describe("errors", () => {
  // page.route does not see the requests that go through a service worker.
  test.use({ serviceWorkers: "block" });

  test("a switch goes back after an error, with a toast (#104)", async ({
    page,
  }) => {
    await signIn(page);
    const endpoint = `https://127.0.0.1:1/push/${randomUUID()}`;
    const label = `Error device ${randomUUID().slice(0, 8)}`;
    await saveFakeSubscription(page, endpoint, label);
    const name = `Errors ${randomUUID().slice(0, 8)}`;
    await createList(page, name);
    await expect
      .poll(async () => {
        const pull = await page.request.get("/api/sync/pull?since=0");
        return (await pull.json()).lists.some(
          (l: { name: string }) => l.name === name,
        );
      })
      .toBe(true);
    try {
      await page.route("**/api/push/subscriptions/*", (route) =>
        route.fulfill({ status: 500 }),
      );
      await page.route("**/api/push/mutes", (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({ status: 500 })
          : route.fallback(),
      );
      await page.goto("/settings");

      const deviceName = copy.settings.deviceSwitch(label);
      const device = page.getByRole("switch", { name: deviceName });
      await expect(device).toBeChecked();
      await switchControl(page, deviceName).click();
      await expect(
        page.locator("wa-toast-item", { hasText: copy.settings.deviceFailed }),
      ).toBeVisible();
      await expect(device).toBeChecked();

      await page
        .getByRole("button", { name: `${copy.settings.remove} ${label}` })
        .click();
      await expect(
        page.locator("wa-toast-item", { hasText: copy.settings.removeFailed }),
      ).toBeVisible();
      await expect(device).toBeVisible();

      const listName = copy.settings.listSwitch(name);
      const list = page.getByRole("switch", { name: listName });
      await expect(list).toBeChecked();
      await switchControl(page, listName).click();
      await expect(
        page.locator("wa-toast-item", {
          hasText: copy.list.notificationsFailed,
        }),
      ).toBeVisible();
      await expect(list).toBeChecked();
    } finally {
      await page.unrouteAll();
      await removeFakeSubscription(page, endpoint);
    }
  });
});

test("this device: Safari on iPhone asks for the Home Screen app", async ({
  page,
  context,
}, testInfo) => {
  if (testInfo.project.name !== "mobile") {
    await context.grantPermissions(["notifications"]);
  }
  await signIn(page);
  await page.goto("/settings");
  const section = page.getByRole("region", { name: copy.settings.thisDevice });
  if (testInfo.project.name === "mobile") {
    await expect(section).toContainText(copy.settings.pushNeedsInstall);
  } else {
    // Headless Chromium can keep notifications blocked. Both states are
    // right here; the iPhone message is not.
    await expect(
      section
        .getByRole("button", { name: copy.settings.enablePush })
        .or(section.getByText(copy.settings.pushBlocked)),
    ).toBeVisible();
    await expect(section).not.toContainText(copy.settings.pushNeedsInstall);
  }
});

test("the connector URL shows, and the copy button copies it", async ({
  page,
  baseURL,
}) => {
  // Keep the copied text in the page. The real clipboard needs a permission
  // that WebKit does not give to tests.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await signIn(page);
  await page.goto("/settings");
  const url = `${baseURL}/mcp`;
  await expect(
    page.getByRole("textbox", { name: copy.settings.connectorUrl }),
  ).toHaveValue(url);
  await page.getByRole("button", { name: copy.settings.copyUrl }).click();
  // The toaster also puts the text in a live region, thus find the toast.
  await expect(
    page.locator("wa-toast-item").filter({ hasText: copy.settings.copied }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as { copied?: string }).copied))
    .toBe(url);
});
