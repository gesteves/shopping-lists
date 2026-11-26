import { describe, expect, it } from "vitest";
import { openUrl, targetUrl, type WindowLike } from "./open-url";

const ORIGIN = "https://lists.example";

function fakeClients(urls: string[]) {
  const log: string[] = [];
  const windows: WindowLike[] = urls.map((url) => ({
    url,
    focus: async () => log.push(`focus ${url}`),
    navigate: async (to: string) => log.push(`navigate ${to}`),
  }));
  return {
    log,
    clients: {
      matchAll: async () => windows,
      openWindow: async (to: string) => log.push(`open ${to}`),
    },
  };
}

describe("targetUrl", () => {
  it("keeps a same-origin path", () => {
    expect(targetUrl("/lists/abc", ORIGIN)).toBe(`${ORIGIN}/lists/abc`);
  });

  it("gives the home page for a different origin or bad data", () => {
    expect(targetUrl("https://evil.example/x", ORIGIN)).toBe(`${ORIGIN}/`);
    expect(targetUrl(undefined, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(targetUrl("http://[bad", ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

describe("openUrl", () => {
  const url = `${ORIGIN}/lists/abc`;

  it("focuses a window that shows the page", async () => {
    const { clients, log } = fakeClients([`${ORIGIN}/`, url]);
    await openUrl(clients, url);
    expect(log).toEqual([`focus ${url}`]);
  });

  it("moves an open window of the app to the page", async () => {
    const { clients, log } = fakeClients([`${ORIGIN}/`]);
    await openUrl(clients, url);
    expect(log).toEqual([`focus ${ORIGIN}/`, `navigate ${url}`]);
  });

  it("opens a window when none is open", async () => {
    const { clients, log } = fakeClients([]);
    await openUrl(clients, url);
    expect(log).toEqual([`open ${url}`]);
  });
});
