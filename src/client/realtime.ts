import type { PresenceSnapshot } from "@/shared/presence";

// The SSE client (#11). Each `poke` from the server starts a sync. The
// stream is open only while the page is visible: iOS stops the connections
// of a hidden app anyway, and a sync runs when the app comes back.

/** The parts of `document` that this module uses. Tests give a fake. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface RealtimeOptions {
  /** Called for each poke. */
  onPoke: () => void;
  /** Called at each (re)connection. Changes can come while it is closed. */
  onOpen?: () => void;
  /** Called with each presence snapshot, and with null when the stream
   * closes (presence is hidden while offline). */
  onPresence?: (snapshot: PresenceSnapshot | null) => void;
  url?: string;
  EventSource?: typeof EventSource;
  document?: VisibilitySource;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The first wait after the browser stops trying. It doubles to 60 s. */
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/** Start the stream. It returns a function that stops it. */
export function startRealtime(options: RealtimeOptions): () => void {
  const Source = options.EventSource ?? EventSource;
  const doc = options.document ?? document;
  const url = options.url ?? "/api/events";
  const later = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.clearTimeout ??
    ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let source: EventSource | null = null;
  let retry: unknown = null;
  let failures = 0;
  let stopped = false;

  const open = () => {
    if (stopped || source || doc.visibilityState !== "visible") return;
    const current = new Source(url);
    source = current;
    current.addEventListener("open", () => {
      failures = 0;
      options.onOpen?.();
    });
    current.addEventListener("poke", () => options.onPoke());
    current.addEventListener("presence", (event) => {
      try {
        options.onPresence?.(JSON.parse((event as MessageEvent).data));
      } catch {
        // A bad event. The next one replaces it.
      }
    });
    current.addEventListener("error", () => {
      options.onPresence?.(null);
      // The browser connects again by itself after a network error. After
      // an HTTP error (for example, 401) the state is CLOSED: try again
      // later.
      if (current.readyState !== Source.CLOSED || source !== current) return;
      source = null;
      failures++;
      const wait = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (failures - 1));
      retry = later(() => {
        retry = null;
        open();
      }, wait);
    });
  };

  const close = () => {
    if (source) options.onPresence?.(null);
    source?.close();
    source = null;
    if (retry !== null) cancel(retry);
    retry = null;
  };

  const onVisibility = () => {
    if (doc.visibilityState === "visible") open();
    else close();
  };

  doc.addEventListener("visibilitychange", onVisibility);
  open();
  return () => {
    stopped = true;
    close();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
