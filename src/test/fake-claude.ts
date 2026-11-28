// A fake Claude client for tests: no request leaves the process. Its
// `create().withResponse()` gives what `respond` returns, with a request ID.
import { vi } from "vitest";

export function fakeClaude(
  respond: (params: Record<string, unknown>) => unknown,
  requestId = "req_test",
) {
  const create = vi.fn((params: Record<string, unknown>) => ({
    withResponse: async () => ({
      data: await respond(params),
      request_id: requestId,
    }),
  }));
  return { client: { beta: { messages: { create } } } as never, create };
}

/** A message whose text is `json` as JSON (or the string as it is). */
export function claudeMessage(json: unknown, stop_reason = "end_turn") {
  return {
    model: "claude-sonnet-5-5",
    stop_reason,
    content: [
      {
        type: "text",
        text: typeof json === "string" ? json : JSON.stringify(json),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, iterations: null },
  };
}
