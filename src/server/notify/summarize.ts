// The push text from Claude (#17, #89): one sentence for the changes. See
// "Notifications" in docs/PLAN.md. Each failure (no key, an error, a
// timeout, a refusal, a bad answer, a too long answer) gives the fixed
// fallback from templates.ts, so a push always goes out.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { prompts } from "@/prompts";
import { logClaudeError, logClaudeResponse } from "../claude-log";
import { renderFallback, who } from "./templates";
import { snapshotFor, type ActivityEvent } from "./types";

export const MODEL = "claude-sonnet-5-5";
/**
 * A longer answer gives the fallback. The server does not cut the text: the
 * device cuts it when necessary (Apple guidelines). It is more than
 * `prompts.notificationSummary.length`.
 */
export const MAX_BODY = 200;
/** A refused request goes again on the model that Anthropic recommends. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const Summary = z.object({ body: z.string() });

/**
 * The most changes in the model input. A larger burst gives only the counts
 * of the other changes, thus the request stays small.
 */
export const MAX_INPUT_CHANGES = 50;

/** The model input: names only, never emails or IDs. */
export function summaryInput(events: ActivityEvent[], actorName: string) {
  const shown = events.slice(0, MAX_INPUT_CHANGES);
  const rest = events.slice(MAX_INPUT_CHANGES);
  const types: Record<string, number> = {};
  for (const e of rest) types[e.type] = (types[e.type] ?? 0) + 1;
  return {
    actor: who(actorName, events[0].via),
    ...(rest.length > 0 && { more: { count: rest.length, types } }),
    changes: shown.map((e) => {
      // Only the keys of the type: an add never says "renamed" or "moved".
      const s = snapshotFor(e.type, e.snapshot);
      return {
        type: e.type,
        list: s.listName,
        ...(s.itemName !== undefined && { item: s.itemName }),
        ...(s.oldName !== undefined && { oldName: s.oldName }),
        ...(s.fromListName !== undefined && { fromList: s.fromListName }),
        ...(s.count !== undefined && { count: s.count }),
        ...(s.fields !== undefined && { fields: s.fields }),
      };
    }),
  };
}

/** One line, at most `max` characters, cut at a word if it is longer. */
export function cleanLine(text: string, max: number): string {
  let line = text.replace(/\s+/g, " ").trim();
  // Remove quotes only if one pair wraps the whole line: names in the line
  // have their own curly quotes.
  const wrapped = /^"([^"]*)"$/.exec(line) ?? /^“([^“”]*)”$/.exec(line);
  if (wrapped) line = wrapped[1].trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * One sentence with a period at the end, or null if it is empty or longer
 * than MAX_BODY.
 */
export function cleanBody(text: string): string | null {
  let body = cleanLine(text, Infinity);
  if (!body) return null;
  if (!/[.!?…]$/.test(body)) body = `${body}.`;
  return body.length <= MAX_BODY ? body : null;
}

export interface SummarizerOptions {
  /** For tests. */
  client?: Pick<Anthropic, "beta">;
  apiKey?: string;
}

/**
 * The `summarize` function of the notifier. Without ANTHROPIC_API_KEY it
 * gives the fallback and does not call Claude.
 */
export function createSummarizer(options: SummarizerOptions = {}) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client =
    options.client ??
    (apiKey ? new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 }) : null);

  return async (events: ActivityEvent[], actorName: string) => {
    const fallback = renderFallback(events, actorName);
    if (!client) return fallback;
    const started = Date.now();
    try {
      const response = await client.beta.messages.parse({
        model: MODEL,
        // Thinking is always on and counts toward this limit.
        max_tokens: 4000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: {
          effort: "low",
          format: betaZodOutputFormat(Summary),
        },
        system: prompts.notificationSummary.system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(summaryInput(events, actorName)),
          },
        ],
      });
      logClaudeResponse("push text", Date.now() - started, response);
      // A refusal (also after the fallback model), a cut answer, or JSON
      // that did not parse.
      if (response.stop_reason !== "end_turn" || !response.parsed_output) {
        console.warn("Summary not used:", response.stop_reason);
        return fallback;
      }
      const body = cleanBody(response.parsed_output.body);
      if (!body) console.warn("Summary not used: empty or too long");
      return body ?? fallback;
    } catch (error) {
      logClaudeError("push text", Date.now() - started, error);
      return fallback;
    }
  };
}
