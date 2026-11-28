// The tests never call Claude: each guard is in place. See "Claude in
// tests" in CLAUDE.md.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import playwrightConfig from "../../playwright.config";
import { createSummarizer } from "@/server/notify/summarize";
import { createListSummarizer } from "@/server/summary/summarize";
import { isAnthropicHost } from "./no-claude";

describe("no Claude in the unit tests", () => {
  it("has no API key, also when the shell has one", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBe("");
    expect(createListSummarizer()).toBeNull();
  });

  it("gives the fallback text and makes no request without a client", async () => {
    const summarize = createSummarizer();
    const event = {
      id: 1,
      actorId: "u",
      via: "app" as const,
      type: "addItem" as const,
      listId: "l",
      itemId: "i",
      snapshot: { listName: "Target", itemName: "Milk" },
      at: 0,
    };
    expect(await summarize([event], "Sam")).toBe(
      "Sam added “Milk” to the “Target” list.",
    );
  });

  it("stops each request to an Anthropic host", async () => {
    expect(isAnthropicHost("api.anthropic.com")).toBe(true);
    expect(isAnthropicHost("anthropic.com")).toBe(true);
    expect(isAnthropicHost("notanthropic.com")).toBe(false);
    await expect(
      fetch("https://api.anthropic.com/v1/messages", { method: "POST" }),
    ).rejects.toThrow(/must not call Claude/);
    // Also through the SDK, with a key.
    const client = new Anthropic({ apiKey: "test-key", maxRetries: 0 });
    await expect(
      client.messages.create({
        model: "claude-haiku-5-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/must not call Claude/),
      }),
    });
  });
});

describe("no Claude in the e2e tests", () => {
  const server = [playwrightConfig.webServer].flat()[0]!;

  it("starts the server with an empty key", () => {
    expect(server.env?.ANTHROPIC_API_KEY).toBe("");
  });

  it("never uses a server that is already on the port", () => {
    expect(server.reuseExistingServer).toBe(false);
  });
});
