import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ev } from "@/test/notify-events";
import {
  MAX_BODY,
  MODEL,
  cleanBody,
  createSummarizer,
  summaryInput,
} from "./summarize";

const events = [
  ev("addItem", { itemName: "Milk" }, { itemId: "a" }),
  ev("addItem", { itemName: "Eggs" }, { itemId: "b" }),
  ev(
    "check",
    { itemName: "Bread", listName: "Target" },
    { listId: "l2", itemId: "c" },
  ),
];
const FALLBACK = "Sam made 3 changes to 2 lists";

/** A fake client whose parse() does what the test says. */
function fakeClient(parse: (...args: unknown[]) => unknown) {
  const fn = vi.fn(parse);
  return { client: { beta: { messages: { parse: fn } } } as never, parse: fn };
}

function answer(body: string, stop_reason = "end_turn") {
  return { stop_reason, parsed_output: { body }, content: [] };
}

describe("createSummarizer", () => {
  it("returns the line from Claude", async () => {
    const { client, parse } = fakeClient(async () =>
      answer(
        "Sam added “Milk” and “Eggs” to “Whole Foods” and checked “Bread” off “Target”",
      ),
    );
    const summarize = createSummarizer({ client });
    expect(await summarize(events, "Sam")).toBe(
      "Sam added “Milk” and “Eggs” to “Whole Foods” and checked “Bread” off “Target”",
    );

    const [request] = parse.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      model: MODEL,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    expect(request.output_config).toHaveProperty("format");
    const sent = JSON.stringify(request.messages);
    expect(sent).toContain("Milk");
    // Names only: no emails and no IDs.
    expect(sent).not.toMatch(/@|list-1|"l2"|item-1/);
  });

  it("falls back on a refusal", async () => {
    const { client } = fakeClient(async () => answer("", "refusal"));
    expect(await createSummarizer({ client })(events, "Sam")).toBe(FALLBACK);
  });

  it("falls back when the answer does not parse or is cut", async () => {
    const { client } = fakeClient(async () => ({
      stop_reason: "end_turn",
      parsed_output: null,
    }));
    expect(await createSummarizer({ client })(events, "Sam")).toBe(FALLBACK);
    const cut = fakeClient(async () => answer("Sam added", "max_tokens"));
    expect(await createSummarizer({ client: cut.client })(events, "Sam")).toBe(
      FALLBACK,
    );
    const empty = fakeClient(async () => answer("   "));
    expect(
      await createSummarizer({ client: empty.client })(events, "Sam"),
    ).toBe(FALLBACK);
  });

  it("falls back on an API error", async () => {
    const { client } = fakeClient(async () => {
      throw new Anthropic.InternalServerError(
        500,
        undefined,
        "boom",
        new Headers(),
      );
    });
    expect(await createSummarizer({ client })(events, "Sam")).toBe(FALLBACK);
  });

  it("falls back on a timeout", async () => {
    const { client } = fakeClient(async () => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    expect(await createSummarizer({ client })(events, "Sam")).toBe(FALLBACK);
  });

  it("does not call Claude without an API key", async () => {
    const summarize = createSummarizer({ apiKey: "" });
    expect(await summarize(events, "Sam")).toBe(FALLBACK);
  });

  it("caps a long line", async () => {
    const long = `Sam ${"added lots of things ".repeat(20)}`;
    const { client } = fakeClient(async () => answer(long));
    const body = await createSummarizer({ client })(events, "Sam");
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("summaryInput", () => {
  it("names the actor with via Claude, and keeps only names", () => {
    const input = summaryInput(
      [
        ev(
          "moveItem",
          { itemName: "Tea", listName: "B", fromListName: "A" },
          {},
          { via: "mcp" },
        ),
      ],
      "Sam",
    );
    expect(input).toEqual({
      actor: "Sam (via Claude)",
      changes: [{ type: "moveItem", list: "B", item: "Tea", fromList: "A" }],
    });
  });
});

describe("cleanBody", () => {
  it("makes one line and removes quotes around it", () => {
    expect(cleanBody(' "Sam added\n“Milk”" ')).toBe("Sam added “Milk”");
    expect(cleanBody("Sam added “Milk” to “Target”")).toBe(
      "Sam added “Milk” to “Target”",
    );
    expect(cleanBody("“Sam made changes”")).toBe("Sam made changes");
  });
});
