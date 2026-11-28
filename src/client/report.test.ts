import { describe, expect, it } from "vitest";
import { DEDUPE_MS, MAX_PER_MINUTE, createReporter } from "./report";

function setup(online = true) {
  const sent: Record<string, unknown>[] = [];
  let now = 1_000_000;
  const report = createReporter({
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
    now: () => now,
    isOnline: () => online,
    page: () => "/lists/abc?x=1",
  });
  return { report, sent, advance: (ms: number) => (now += ms) };
}

describe("createReporter", () => {
  it("sends the area, the name, a clean message, and the path", () => {
    const { report, sent } = setup();
    const error = Object.assign(
      new Error("Can’t add “Gift for Alex” to the list"),
      { status: 503 },
    );
    report("add", error);
    expect(sent).toEqual([
      {
        area: "add",
        name: "Error",
        msg: 'Can’t add "…" to the list',
        status: 503,
        page: "/lists/abc",
      },
    ]);
  });

  it("sends the same error one time in DEDUPE_MS", () => {
    const { report, sent, advance } = setup();
    report("sync", new RangeError("Bad cursor"));
    report("sync", new RangeError("Bad cursor"));
    expect(sent).toHaveLength(1);
    advance(DEDUPE_MS);
    report("sync", new RangeError("Bad cursor"));
    expect(sent).toHaveLength(2);
  });

  it("sends no network error, and no URL", () => {
    const { report, sent } = setup();
    report("sync", new TypeError("Load failed"));
    report("sync", new TypeError("Failed to fetch"));
    report("sync", new DOMException("signal timed out", "TimeoutError"));
    report(
      "sync",
      new TypeError("NetworkError when attempting to fetch resource."),
    );
    expect(sent).toEqual([]);
    report(
      "unhandled",
      new TypeError("Script https://shop.test/sw.js?v=1 load failed"),
    );
    expect(sent[0]).toMatchObject({ msg: "Script <url> load failed" });
  });

  it("sends at most MAX_PER_MINUTE, and nothing offline", () => {
    const { report, sent } = setup();
    for (let n = 0; n < MAX_PER_MINUTE + 5; n++) {
      report("unhandled", new Error(`error ${n}`));
    }
    expect(sent).toHaveLength(MAX_PER_MINUTE);
    const offline = setup(false);
    offline.report("sync", new Error("x"));
    expect(offline.sent).toEqual([]);
  });

  it("never throws, also for a value that is not an Error", () => {
    const { report, sent } = setup();
    expect(() => report("unhandled", "a string")).not.toThrow();
    expect(sent[0]).toMatchObject({ name: "string", msg: "" });
  });
});
