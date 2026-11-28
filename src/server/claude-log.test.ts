import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logClaudeError, logClaudeResponse } from "./claude-log";

afterEach(() => vi.restoreAllMocks());

function response(patch: object = {}) {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 40, iterations: null },
    _request_id: "req_1",
    ...patch,
  } as unknown as Anthropic.Beta.BetaMessage;
}

describe("logClaudeResponse", () => {
  it("logs the time, the model, the stop reason, the tokens, and the ID", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logClaudeResponse("list summary", 1234, response());
    expect(info).toHaveBeenCalledWith(
      "[claude] list summary ms=1234 model=claude-sonnet-5-5 stop=end_turn in=120 out=40 request=req_1",
    );
  });

  it("says when a fallback model answered", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    logClaudeResponse(
      "push text",
      5,
      response({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          iterations: [{ type: "fallback_message" }],
        },
      }),
    );
    expect(info.mock.calls[0][0]).toContain(" fallback=yes ");
  });

  it("does not throw for a response with no usage", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(() =>
      logClaudeResponse("push text", 5, response({ usage: undefined })),
    ).not.toThrow();
    expect(info.mock.calls[0][0]).toContain("in=- out=-");
  });
});

describe("logClaudeError", () => {
  it("logs a timeout and an API error, with no message text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logClaudeError(
      "list summary",
      20_000,
      new Anthropic.APIConnectionTimeoutError(),
    );
    logClaudeError("list summary", 3, new Error("Milk and eggs"));
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "[claude] list summary failed ms=20000 timeout",
      "[claude] list summary failed ms=3 Error",
    ]);
  });
});
