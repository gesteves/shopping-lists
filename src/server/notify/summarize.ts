// A one-line summary from Claude for a push with more than one change
// (#17). See "Notifications" in docs/PLAN.md. Each failure (no key, an
// error, a timeout, a refusal, a bad answer) gives the fixed fallback from
// templates.ts, so a push always goes out.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { prompts } from "@/prompts";
import { renderFallback, who } from "./templates";
import type { ActivityEvent } from "./types";

export const MODEL = "claude-opus-5-5";
/** The server cuts at this. It is more than `prompts.notificationSummary.length`. */
export const MAX_BODY = 160;
/** A refused request goes again on the model that Anthropic recommends. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const Summary = z.object({ body: z.string() });

/** The model input: names only, never emails or IDs. */
export function summaryInput(events: ActivityEvent[], actorName: string) {
  return {
    actor: who(actorName, events[0].via),
    changes: events.map((e) => ({
      type: e.type,
      list: e.snapshot.listName,
      ...(e.snapshot.itemName !== undefined && { item: e.snapshot.itemName }),
      ...(e.snapshot.oldName !== undefined && { oldName: e.snapshot.oldName }),
      ...(e.snapshot.fromListName !== undefined && {
        fromList: e.snapshot.fromListName,
      }),
      ...(e.snapshot.count !== undefined && { count: e.snapshot.count }),
    })),
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

/** One line, at most MAX_BODY characters, cut at a word if it is longer. */
export function cleanBody(text: string): string {
  return cleanLine(text, MAX_BODY);
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
      // A refusal (also after the fallback model), a cut answer, or JSON
      // that did not parse.
      if (response.stop_reason !== "end_turn" || !response.parsed_output) {
        console.warn("Summary not used:", response.stop_reason);
        return fallback;
      }
      const body = cleanBody(response.parsed_output.body);
      return body || fallback;
    } catch (error) {
      console.warn(
        "Summary failed:",
        error instanceof Anthropic.APIError ? error.status : error,
      );
      return fallback;
    }
  };
}
