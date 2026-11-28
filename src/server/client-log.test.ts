import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "@/test/logs";
import {
  MAX_CLIENT_LOGS_PER_MINUTE,
  handleClientLog,
  resetClientLogLimits,
} from "./client-log";

afterEach(() => {
  resetClientLogLimits();
  vi.restoreAllMocks();
});

function post(body: unknown) {
  return new Request("http://localhost/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD = {
  area: "sync",
  name: "TypeError",
  msg: "Load failed",
  page: "/lists/abc",
};

describe("handleClientLog", () => {
  it("writes one warn line, and cleans the message and the page again", async () => {
    const logs = captureLogs();
    const res = await handleClientLog(
      post({
        ...GOOD,
        msg: 'Failed on "Milk"',
        page: "/lists/abc?q=Milk",
        status: 500,
      }),
      "user-1",
    );
    expect(res.status).toBe(204);
    expect(logs.lines).toEqual([
      'warn [client] error area=sync err=TypeError msg="Failed on \\"…\\"" status=500 page=/lists/abc user=user-1',
    ]);
    expect(logs.text()).not.toContain("Milk");
  });

  it("refuses a bad body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      (await handleClientLog(post({ ...GOOD, area: "x" }), "u")).status,
    ).toBe(400);
    expect(
      (await handleClientLog(post({ ...GOOD, extra: 1 }), "u")).status,
    ).toBe(400);
    expect(
      (await handleClientLog(post({ ...GOOD, msg: "x".repeat(500) }), "u"))
        .status,
    ).toBe(400);
  });

  it("drops the lines over the limit of each user", async () => {
    const logs = captureLogs();
    for (let n = 0; n < MAX_CLIENT_LOGS_PER_MINUTE + 3; n++) {
      expect(
        (await handleClientLog(post(GOOD), "u", { now: () => 0 })).status,
      ).toBe(204);
    }
    expect(logs.find("warn [client]")).toHaveLength(MAX_CLIENT_LOGS_PER_MINUTE);
    await handleClientLog(post(GOOD), "u", { now: () => 60_000 });
    expect(logs.find("warn [client]")).toHaveLength(
      MAX_CLIENT_LOGS_PER_MINUTE + 1,
    );
  });
});
