// One Claude request with a structured output, for the push text and the
// list summary. It logs the request with its ID (#147).
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import type { AutoParseableBetaOutputFormat } from "@anthropic-ai/sdk/lib/beta-parser";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  logClaudeError,
  logClaudeResponse,
  type ClaudeFor,
} from "./claude-log";

/** Why there is no output. */
export type NoOutput =
  "error" | "bad_output" | Exclude<Anthropic.Beta.BetaStopReason, "end_turn">;

export type StructuredResult<T> =
  { output: T; reason?: undefined } | { output: null; reason: NoOutput };

/**
 * Send the request and parse the text with `format`. It does not use
 * `messages.parse()`: that result has no request ID (SDK 1.14), thus it
 * uses `create().withResponse()`. It does not throw.
 */
export async function requestStructured<T>(
  client: Pick<Anthropic, "beta">,
  label: ClaudeFor,
  params: Omit<MessageCreateParamsNonStreaming, "output_config"> & {
    output_config: Omit<
      NonNullable<MessageCreateParamsNonStreaming["output_config"]>,
      "format"
    > & { format: AutoParseableBetaOutputFormat<T> };
  },
): Promise<StructuredResult<T>> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let response: Anthropic.Beta.BetaMessage;
  try {
    const result = await client.beta.messages
      .create({ ...params, stream: false })
      .withResponse();
    response = result.data;
    logClaudeResponse(label, ms(), response, result.request_id);
  } catch (error) {
    logClaudeError(label, ms(), error);
    return { output: null, reason: "error" };
  }
  // A refusal (also after the fallback model), or a cut answer.
  if (response.stop_reason !== "end_turn") {
    return { output: null, reason: response.stop_reason ?? "bad_output" };
  }
  const text = response.content.find((block) => block.type === "text");
  if (!text || text.type !== "text")
    return { output: null, reason: "bad_output" };
  try {
    return { output: params.output_config.format.parse(text.text) };
  } catch {
    // JSON that does not parse, or that does not match the schema.
    return { output: null, reason: "bad_output" };
  }
}
