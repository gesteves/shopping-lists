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
    { itemName: "Bread", listName: "Oasis" },
    { listId: "l2", itemId: "c" },
  ),
];
const FALLBACK = "Sam made 3 changes to 2 lists.";

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
        "Sam added milk and eggs to the “Pierre’s General Store” list and checked off bread in the “Oasis” list.",
      ),
    );
    const summarize = createSummarizer({ client });
    expect(await summarize(events, "Sam")).toBe(
      "Sam added milk and eggs to the “Pierre’s General Store” list and checked off bread in the “Oasis” list.",
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

  it("does not cut a long line: it gives the fallback", async () => {
    const long = `Sam ${"added lots of things ".repeat(20)}`;
    expect(long.length).toBeGreaterThan(MAX_BODY);
    const { client } = fakeClient(async () => answer(long));
    expect(await createSummarizer({ client })(events, "Sam")).toBe(FALLBACK);
  });

  it("writes one change too, with its sentence as the fallback", async () => {
    const one = [ev("addItem", { itemName: "Eggs" })];
    const { client, parse } = fakeClient(async () =>
      answer("Sam added eggs to the “Pierre’s General Store” list."),
    );
    expect(await createSummarizer({ client })(one, "Sam")).toBe(
      "Sam added eggs to the “Pierre’s General Store” list.",
    );
    expect(parse).toHaveBeenCalledOnce();
    expect(await createSummarizer({ apiKey: "" })(one, "Sam")).toBe(
      "Sam added “Eggs” to the “Pierre’s General Store” list.",
    );
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

  it("sends the fields that an update changed", () => {
    const input = summaryInput(
      [ev("updateItem", { itemName: "Eggs", fields: ["notes"] })],
      "Sam",
    );
    expect(input.changes).toEqual([
      {
        type: "updateItem",
        list: "Pierre’s General Store",
        item: "Eggs",
        fields: ["notes"],
      },
    ]);
  });

  it("sends only the keys of the type", () => {
    const input = summaryInput(
      [
        ev("addItem", {
          itemName: "Oat milk",
          oldName: "Milk",
          fromListName: "A",
          fields: ["name"],
        }),
      ],
      "Sam",
    );
    expect(input.changes).toEqual([
      { type: "addItem", list: "Pierre’s General Store", item: "Oat milk" },
    ]);
  });
});

describe("cleanBody", () => {
  it("makes one line and removes quotes around it", () => {
    expect(cleanBody(' "Sam added\n“Milk”." ')).toBe("Sam added “Milk”.");
    expect(cleanBody("“Sam made changes.”")).toBe("Sam made changes.");
  });

  it("adds a period if the sentence has none", () => {
    expect(cleanBody("Sam added milk to the “Oasis” list")).toBe(
      "Sam added milk to the “Oasis” list.",
    );
    expect(cleanBody("Sam renamed the “A” list to “B”")).toBe(
      "Sam renamed the “A” list to “B”.",
    );
    expect(cleanBody("Sam added milk!")).toBe("Sam added milk!");
  });

  it("gives null for an empty or too long line", () => {
    expect(cleanBody("  ")).toBeNull();
    expect(cleanBody("x".repeat(MAX_BODY))).toBeNull();
    expect(cleanBody(`${"x".repeat(MAX_BODY - 1)}.`)).not.toBeNull();
  });
});
