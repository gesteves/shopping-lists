// The link of an item (#140). The browser and the server both use this file.

/** The maximum length of an item URL. */
export const URL_MAX = 2000;

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * True if `value` is an http or https URL with a host. Only these URLs can
 * go in an item: the app opens them in a new tab, thus a `javascript:` URL
 * must never get in.
 */
export function isWebUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !!url.host;
}

/**
 * What the user typed, as a URL: trimmed, and with `https://` when it has
 * no scheme ("example.com/milk"). An empty string stays empty (no link).
 * Undefined if the text is not a web URL.
 */
export function normalizeUrl(input: string): string | undefined {
  const value = input.trim();
  if (value === "") return "";
  // "localhost:3000" looks like a scheme, but has digits after the colon.
  const url =
    SCHEME.test(value) && !/^[^/]+:\d/.test(value) ? value : `https://${value}`;
  return isWebUrl(url) && url.length <= URL_MAX ? url : undefined;
}

/** The host of the URL for the item row, without "www.". */
export function urlHost(value: string): string {
  if (!URL.canParse(value)) return value;
  return new URL(value).hostname.replace(/^www\./, "");
}
