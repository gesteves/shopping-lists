// One log line for each Claude request (the push text and the list
// summary): how long it took, and what came back. It has no user text: no
// list names and no item names.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log";

/** What the request is for. */
export type ClaudeFor = "push-text" | "list-summary";

/**
 * Log a request that gave a response. `ms` includes the retry of the SDK
 * (1 retry, 10 s timeout each). A fallback model answered if the usage has
 * a `fallback_message` iteration.
 */
export function logClaudeResponse(
  label: ClaudeFor,
  ms: number,
  response: Anthropic.Beta.BetaMessage,
  requestId: string | null | undefined,
) {
  const usage = response.usage as
    Anthropic.Beta.BetaMessage["usage"] | undefined;
  const fallback = (usage?.iterations ?? []).some(
    (i) => i.type === "fallback_message",
  );
  log.info("claude", "response", {
    for: label,
    ms,
    model: response.model ?? "-",
    fallback: fallback ? "yes" : undefined,
    stop: response.stop_reason,
    in: usage?.input_tokens ?? "-",
    out: usage?.output_tokens ?? "-",
    request: requestId ?? "-",
  });
}

/** Log a request that failed: a timeout, an API error, or another error. */
export function logClaudeError(label: ClaudeFor, ms: number, error: unknown) {
  const fields =
    error instanceof Anthropic.APIConnectionTimeoutError
      ? { reason: "timeout" }
      : error instanceof Anthropic.APIError
        ? {
            reason: "api",
            status: error.status,
            request: error.requestID ?? "-",
          }
        : { reason: "other" };
  // The name only: an error message can have the text of the request.
  log.warn("claude", "failed", { for: label, ms, ...fields }, error);
}
