import { describe, expect, it, vi } from "vitest";
import { MODEL } from "../notify/summarize";
import { MAX_SUMMARY, createListSummarizer, summaryInput } from "./summarize";

const items = [
  { name: "Milk", quantity: 1 },
  { name: "Eggs", quantity: 12 },
];

function fakeClient(parse: (...args: unknown[]) => unknown) {
  const fn = vi.fn(parse);
  return { client: { beta: { messages: { parse: fn } } } as never, parse: fn };
}

function answer(summary: string, stop_reason = "end_turn") {
  return { stop_reason, parsed_output: { summary }, content: [] };
}

describe("createListSummarizer", () => {
  it("returns the line from Claude", async () => {
    const { client, parse } = fakeClient(async () =>
      answer("Milk and a dozen eggs"),
    );
    const summarize = createListSummarizer({ client })!;
    expect(await summarize("Costco", items)).toBe("Milk and a dozen eggs");
    const [request] = parse.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      model: MODEL,
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    expect(JSON.stringify(request.messages)).toContain("Eggs");
  });

  it("cuts a long line", async () => {
    const { client } = fakeClient(async () => answer("word ".repeat(40)));
    const line = await createListSummarizer({ client })!("Costco", items);
    expect(line!.length).toBeLessThanOrEqual(MAX_SUMMARY);
    expect(line).toMatch(/…$/);
  });

  it("gives null on a refusal, an error, or an empty line", async () => {
    for (const parse of [
      async () => answer("", "refusal"),
      async () => answer("   "),
      async () => {
        throw new Error("timeout");
      },
    ]) {
      const { client } = fakeClient(parse);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await createListSummarizer({ client })!("Costco", items)).toBe(
        null,
      );
      warn.mockRestore();
    }
  });

  it("is null without an API key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createListSummarizer()).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("summaryInput", () => {
  it("sends names and quantities only", () => {
    expect(
      summaryInput("Costco", [
        { name: "Milk", quantity: 2, id: "secret" } as never,
      ]),
    ).toEqual({ list: "Costco", items: [{ name: "Milk", quantity: 2 }] });
  });
});
