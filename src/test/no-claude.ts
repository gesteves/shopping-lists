// The unit tests never call Claude (the Anthropic API). vitest.config.mts
// sets ANTHROPIC_API_KEY to an empty string, and this setup file stops each
// request to an Anthropic host: the SDK uses the global fetch. A test that
// needs a response gives a fake client (`client` in the summarizer
// options).

/** The hosts of the Anthropic API. */
export function isAnthropicHost(host: string): boolean {
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

function hostOf(input: Parameters<typeof fetch>[0]): string | null {
  try {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const host = hostOf(input);
  if (host !== null && isAnthropicHost(host)) {
    return Promise.reject(
      new Error(
        `A unit test sent a request to ${host}. Tests must not call Claude: give a fake client.`,
      ),
    );
  }
  return realFetch(input, init);
};
