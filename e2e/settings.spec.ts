import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { copy } from "../src/copy";
import { anyCount, escapeRegExp, signIn, switchControl } from "./helpers";

/** A device with a fake push endpoint, saved through the API. */
async function fakeDevice(page: Page) {
  const label = `Test device ${randomUUID().slice(0, 8)}`;
  const res = await page.request.post("/api/push/subscriptions", {
    data: {
      // Refused at once, with no DNS lookup. A lookup that hangs blocks the
      // Node thread pool and slows the whole server.
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

test("the push routes need a session", async ({ request }) => {
  expect((await request.get("/api/push/subscriptions")).status()).toBe(401);
  expect((await request.post("/api/push/test")).status()).toBe(401);
  expect((await request.get("/api/push/mutes")).status()).toBe(401);
});

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
  await switchControl(page, toggleName).click();
  await expect(toggle).not.toBeChecked();
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

test("mute and unmute a list", async ({ page }) => {
  await signIn(page);
  const name = `Mute ${randomUUID().slice(0, 8)}`;
  const index = page
    .getByRole("region", { name: copy.lists.heading })
    .filter({ visible: true });
  await index.getByLabel(copy.lists.newName).fill(name);
  await index.getByRole("button", { name: copy.lists.create }).click();
  await expect(index.getByRole("link", { name })).toBeVisible();
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
  await switchControl(page, toggleName).click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await switchControl(page, toggleName).click();
  // The switch changes after the server saves it. Then reload.
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
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
