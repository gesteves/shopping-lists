// A one-line summary from Claude of the unchecked items of a list. The lists
// page shows it under the list name. See "List summaries" in
// docs/PLAN.md. Each failure (an error, a timeout, a refusal, a bad answer)
// gives null: the worker tries again later, and the page shows the count.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { prompts } from "@/prompts";
import type { SummaryItem } from "@/shared/summary";
import { logClaudeError, logClaudeResponse } from "../claude-log";
import { FALLBACK_BETA, MODEL, cleanLine } from "../notify/summarize";

/** The server cuts at this. It is more than `prompts.listSummary.length`. */
export const MAX_SUMMARY = 90;
/** Send at most this many items. A longer list is cut. */
export const MAX_ITEMS = 200;

const Summary = z.object({ summary: z.string() });

export type { SummaryItem };

/** The model input: names and quantities only, never IDs. */
export function summaryInput(listName: string, items: SummaryItem[]) {
  return {
    list: listName,
    items: items.slice(0, MAX_ITEMS).map((i) => ({
      name: i.name,
      quantity: i.quantity,
    })),
  };
}

export type ListSummarizer = (
  listName: string,
  items: SummaryItem[],
) => Promise<string | null>;

export interface ListSummarizerOptions {
  /** For tests. */
  client?: Pick<Anthropic, "beta">;
  apiKey?: string;
}

/**
 * The `summarize` function of the summary worker, or null without
 * ANTHROPIC_API_KEY.
 */
export function createListSummarizer(
  options: ListSummarizerOptions = {},
): ListSummarizer | null {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client =
    options.client ??
    (apiKey ? new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 }) : null);
  if (!client) return null;

  return async (listName, items) => {
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
        system: prompts.listSummary.system,
        messages: [
          {
            role: "user",
            content: JSON.stringify(summaryInput(listName, items)),
          },
        ],
      });
      logClaudeResponse("list summary", Date.now() - started, response);
      // A refusal (also after the fallback model), a cut answer, or JSON
      // that did not parse.
      if (response.stop_reason !== "end_turn" || !response.parsed_output) {
        console.warn("List summary not used:", response.stop_reason);
        return null;
      }
      return cleanLine(response.parsed_output.summary, MAX_SUMMARY) || null;
    } catch (error) {
      logClaudeError("list summary", Date.now() - started, error);
      return null;
    }
  };
}
