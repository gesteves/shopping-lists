import { describe, expect, it } from "vitest";
import { URL_MAX, isWebUrl, normalizeUrl, urlHost } from "./url";

describe("isWebUrl", () => {
  it("accepts http and https URLs with a host", () => {
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("http://example.com/a?b=c#d")).toBe(true);
  });

  it("refuses other schemes and text that is not a URL", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "mailto:sam@example.com",
      "ftp://example.com",
      "example.com",
      "https://",
      "not a url",
      "",
    ]) {
      expect(isWebUrl(value), value).toBe(false);
    }
  });
});

describe("normalizeUrl", () => {
  it("keeps an empty value empty", () => {
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });

  it("trims, and keeps a URL with a scheme", () => {
    expect(normalizeUrl("  https://example.com/milk ")).toBe(
      "https://example.com/milk",
    );
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("adds https:// when there is no scheme", () => {
    expect(normalizeUrl("example.com/milk")).toBe("https://example.com/milk");
    expect(normalizeUrl("www.example.com")).toBe("https://www.example.com");
    expect(normalizeUrl("example.com:8080/milk")).toBe(
      "https://example.com:8080/milk",
    );
  });

  it("refuses text that is not a web URL", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeUrl("mailto:sam@example.com")).toBeUndefined();
    expect(normalizeUrl("two words")).toBeUndefined();
    expect(
      normalizeUrl(`https://example.com/${"x".repeat(URL_MAX)}`),
    ).toBeUndefined();
  });
});

describe("urlHost", () => {
  it("gives the host without www.", () => {
    expect(urlHost("https://www.example.com/milk")).toBe("example.com");
    expect(urlHost("https://shop.example.com/milk")).toBe("shop.example.com");
  });
});
