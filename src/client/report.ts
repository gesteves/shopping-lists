// Send a browser error to the server log (#147). It sends little: the area,
// the error name, a short message with no quoted text and no URLs, and the
// path. The same error goes one time in DEDUPE_MS, and at most
// MAX_PER_MINUTE go. Nothing goes offline, and no network error goes. It
// never throws.
import {
  cleanMessage,
  cleanPage,
  type ClientLog,
  type ClientLogArea,
} from "@/shared/client-log";

export const DEDUPE_MS = 5 * 60_000;
export const MAX_PER_MINUTE = 10;

export interface ReporterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  isOnline?: () => boolean;
  page?: () => string;
}

/** The name, the message, and the HTTP status of a thrown value. */
function describe(error: unknown): Pick<ClientLog, "name" | "msg" | "status"> {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return {
      name: error.name.slice(0, 60) || "Error",
      msg: cleanMessage(error.message),
      status:
        typeof status === "number" && status >= 100 && status <= 599
          ? status
          : undefined,
    };
  }
  return { name: typeof error, msg: "" };
}

/**
 * A failed or stopped request: no network, a timeout, or a page that
 * closed. The sync tries again by itself, thus it is not a bug. The text is
 * different in each browser.
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return (
    error.name === "TypeError" &&
    /^(load failed|failed to fetch|networkerror|network connection was lost)/i.test(
      error.message,
    )
  );
}

export function createReporter(options: ReporterOptions = {}) {
  const send = options.fetch ?? ((...args) => fetch(...args));
  const now = options.now ?? Date.now;
  const isOnline = options.isOnline ?? (() => navigator.onLine !== false);
  const page = options.page ?? (() => location.pathname);
  const seen = new Map<string, number>();
  let sent: number[] = [];

  return (
    area: ClientLogArea,
    error: unknown,
    extra: { digest?: string } = {},
  ): boolean => {
    try {
      if (!isOnline() || isNetworkError(error)) return false;
      const t = now();
      const body: ClientLog = {
        area,
        ...describe(error),
        ...(extra.digest && { digest: extra.digest.slice(0, 40) }),
        page: cleanPage(page()).slice(0, 200),
      };
      const key = `${area}|${body.name}|${body.msg}`;
      for (const [k, at] of seen) if (t - at >= DEDUPE_MS) seen.delete(k);
      if (seen.has(key)) return false;
      sent = sent.filter((at) => t - at < 60_000);
      if (sent.length >= MAX_PER_MINUTE) return false;
      seen.set(key, t);
      sent.push(t);
      void send("/api/client-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
        // The request finishes also when the page closes.
        keepalive: true,
      }).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  };
}

/** The reporter of the app. */
export const reportError = createReporter();

let installed = false;

/** Report the errors that no code caught, one time for each page. */
export function installErrorReports(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    // A script of another origin gives no detail ("Script error.").
    if (!event.error && !event.message) return;
    reportError("unhandled", event.error ?? new Error(event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("unhandled", event.reason);
  });
}
