import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "@/test/logs";
import { formatLine, log, logLevel, MAX_VALUE, scrub } from "./log";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("formatLine", () => {
  it("writes the level, the area, the event, and the keys in order", () => {
    expect(
      formatLine("info", "sync", "push", {
        user: "u1",
        ops: 3,
        more: false,
        cursor: null,
        seq: undefined,
      }),
    ).toBe("info [sync] push user=u1 ops=3 more=false cursor=-");
  });

  it("quotes a value with a space, an equals sign, a quote, or a newline", () => {
    expect(
      formatLine("warn", "auth", "better-auth", {
        msg: 'a b=c "d"\ne',
        reason: "",
      }),
    ).toBe(String.raw`warn [auth] better-auth msg="a b=c \"d\"\ne" reason=""`);
  });

  it("cuts a long value", () => {
    const line = formatLine("info", "mcp", "call", {
      client: "x".repeat(500),
    });
    expect(line).toBe(`info [mcp] call client=${"x".repeat(MAX_VALUE - 1)}…`);
  });
});

describe("log", () => {
  it("writes each level with the console method of the same name", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    log.debug("presence", "set");
    log.info("boot", "start");
    log.warn("push", "failed");
    log.error("notify", "tick failed");
    expect(debug).toHaveBeenCalledWith("debug [presence] set");
    expect(info).toHaveBeenCalledWith("info [boot] start");
    expect(warn).toHaveBeenCalledWith("warn [push] failed");
    expect(error).toHaveBeenCalledWith("error [notify] tick failed");
  });

  it("skips the levels below LOG_LEVEL, and debug by default", () => {
    const logs = captureLogs();
    log.debug("presence", "set");
    log.info("boot", "start");
    vi.stubEnv("LOG_LEVEL", "warn");
    log.info("boot", "start");
    log.warn("push", "failed");
    expect(logs.lines).toEqual(["info [boot] start", "warn [push] failed"]);
  });

  it("uses info for a bad LOG_LEVEL, and warns one time", () => {
    const logs = captureLogs();
    expect(logLevel("loud")).toBe("info");
    expect(logLevel("loud")).toBe("info");
    expect(logLevel(" DEBUG ")).toBe("debug");
    expect(logLevel("constructor")).toBe("info");
    expect(logs.lines).toEqual([
      "warn [boot] bad LOG_LEVEL log=info",
      "warn [boot] bad LOG_LEVEL log=info",
    ]);
  });

  it("writes the stack only on an error line", () => {
    const logs = captureLogs();
    const failure = new TypeError("Milk and eggs");
    log.warn("push", "failed", { status: 500 }, failure);
    log.error("notify", "tick failed", {}, failure);
    expect(logs.lines[0]).toBe("warn [push] failed status=500 err=TypeError");
    expect(logs.lines[1]).toMatch(
      /^error \[notify\] tick failed err=TypeError\nTypeError: Milk and eggs\n/,
    );
  });

  it("never throws", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("no output");
    });
    expect(() => log.info("boot", "start")).not.toThrow();
  });
});

describe("scrub", () => {
  it("replaces email addresses", () => {
    expect(scrub("User sam@example.com (id 1) not found")).toBe(
      "User <email> (id 1) not found",
    );
  });
});
