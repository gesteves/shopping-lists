import { describe, expect, it, vi } from "vitest";
import { claudeMessage, fakeClaude } from "@/test/fake-claude";
import { MODEL } from "../notify/summarize";
import { MAX_SUMMARY, createListSummarizer, summaryInput } from "./summarize";

const items = [
  { name: "Milk", quantity: 1 },
  { name: "Eggs", quantity: 12 },
];

const fakeClient = fakeClaude;

function answer(summary: string, stop_reason = "end_turn") {
  return claudeMessage({ summary }, stop_reason);
}

describe("createListSummarizer", () => {
  it("returns the line from Claude", async () => {
    const { client, create: parse } = fakeClient(async () =>
      answer("Milk and a dozen eggs"),
    );
    const summarize = createListSummarizer({ client })!;
    expect(await summarize("JojaMart", items)).toBe("Milk and a dozen eggs");
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
    const line = await createListSummarizer({ client })!("JojaMart", items);
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
      vi.spyOn(console, "info").mockImplementation(() => {});
      expect(await createListSummarizer({ client })!("JojaMart", items)).toBe(
        null,
      );
      expect(warn.mock.calls.at(-1)![0]).toMatch(
        /^warn \[summary\] not used reason=/,
      );
      vi.restoreAllMocks();
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
      summaryInput("JojaMart", [
        { name: "Milk", quantity: 2, id: "secret" } as never,
      ]),
    ).toEqual({ list: "JojaMart", items: [{ name: "Milk", quantity: 2 }] });
  });
});
