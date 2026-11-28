import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "@/test/logs";
import { logClaudeError, logClaudeResponse } from "./claude-log";

afterEach(() => vi.restoreAllMocks());

function response(patch: object = {}) {
  return {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 40, iterations: null },
    ...patch,
  } as unknown as Anthropic.Beta.BetaMessage;
}

describe("logClaudeResponse", () => {
  it("logs the time, the model, the stop reason, the tokens, and the ID", () => {
    const logs = captureLogs();
    logClaudeResponse("list-summary", 1234, response(), "req_1");
    expect(logs.lines).toEqual([
      "info [claude] response for=list-summary ms=1234 model=claude-sonnet-5-5 stop=end_turn in=120 out=40 request=req_1",
    ]);
  });

  it("says when a fallback model answered", () => {
    const logs = captureLogs();
    logClaudeResponse(
      "push-text",
      5,
      response({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          iterations: [{ type: "fallback_message" }],
        },
      }),
      null,
    );
    expect(logs.lines[0]).toContain(" fallback=yes ");
    expect(logs.lines[0]).toContain(" request=-");
  });

  it("does not throw for a response with no usage", () => {
    const logs = captureLogs();
    expect(() =>
      logClaudeResponse("push-text", 5, response({ usage: undefined }), "r"),
    ).not.toThrow();
    expect(logs.lines[0]).toContain("in=- out=-");
  });
});

describe("logClaudeError", () => {
  it("logs a timeout and an API error, with no message text", () => {
    const logs = captureLogs();
    logClaudeError(
      "list-summary",
      20_000,
      new Anthropic.APIConnectionTimeoutError(),
    );
    logClaudeError("list-summary", 3, new Error("Milk and eggs"));
    expect(logs.lines).toEqual([
      "warn [claude] failed for=list-summary ms=20000 reason=timeout err=APIConnectionTimeoutError",
      "warn [claude] failed for=list-summary ms=3 reason=other err=Error",
    ]);
  });
});
