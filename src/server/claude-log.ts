// One log line for each Claude request (the push text and the list
// summary): how long it took, and what came back. It has no user text: no
// list names and no item names.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

type Response = Anthropic.Beta.BetaMessage & { _request_id?: string | null };

/**
 * Log a request that gave a response. `ms` includes the retry of the SDK
 * (1 retry, 10 s timeout each). A fallback model answered if the usage has
 * a `fallback_message` iteration.
 */
export function logClaudeResponse(
  label: string,
  ms: number,
  response: Response,
) {
  // A log line never makes the request fail.
  try {
    const usage = response.usage as Response["usage"] | undefined;
    const fallback = (usage?.iterations ?? []).some(
      (i) => i.type === "fallback_message",
    );
    console.info(
      `[claude] ${label} ms=${ms} model=${response.model ?? "-"}` +
        `${fallback ? " fallback=yes" : ""} stop=${response.stop_reason}` +
        ` in=${usage?.input_tokens ?? "-"} out=${usage?.output_tokens ?? "-"}` +
        ` request=${response._request_id ?? "-"}`,
    );
  } catch {
    console.info(`[claude] ${label} ms=${ms}`);
  }
}

/** Log a request that failed: a timeout, an API error, or another error. */
export function logClaudeError(label: string, ms: number, error: unknown) {
  const detail =
    error instanceof Anthropic.APIConnectionTimeoutError
      ? "timeout"
      : error instanceof Anthropic.APIError
        ? `status=${error.status} request=${error.requestID ?? "-"}`
        : error instanceof Error
          ? error.name
          : "unknown";
  console.warn(`[claude] ${label} failed ms=${ms} ${detail}`);
}
