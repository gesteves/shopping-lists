// The SSE stream of GET /api/events (#11). It sends a `poke` event for each
// bus poke, a `presence` event at the start and for each change (#12), and a
// comment every PING_MS. The comments keep the connection
// open: Cloudflare closes a connection that sends nothing for 100 s.
import "server-only";
import type { PresenceSnapshot } from "@/shared/presence";
import { bus, type BusEvents } from "./bus";
import { getPresence } from "./presence";

export const PING_MS = 20_000;
/**
 * A stream closes after this time (#100). The browser connects again, and
 * the route checks the session and the allowlist again.
 */
export const MAX_AGE_MS = 15 * 60_000;
/** The wait before the browser connects again after a lost connection. */
export const RETRY_MS = 3_000;

export const EVENT_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform also stops the gzip layer of Next.js. Gzip can keep the
  // events in its buffer.
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

/** Why a stream closed. */
export type CloseReason = "max_age" | "client" | "error";

let openStreams = 0;

/** The number of open streams in this process. */
export function openStreamCount(): number {
  return openStreams;
}

/** One SSE message. */
export function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A stream of events until `signal` aborts or the client cancels. It
 * removes its bus listener and its timer at the end. `presence` changes
 * each snapshot for the reader of the stream (#154).
 */
export function createEventStream(
  signal: AbortSignal,
  options: {
    pingMs?: number;
    maxAgeMs?: number;
    presence?: (snapshot: PresenceSnapshot) => PresenceSnapshot;
    /** Called one time, after the stream closes. */
    onClose?: (reason: CloseReason) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const view = options.presence ?? ((snapshot) => snapshot);
  const encoder = new TextEncoder();
  let cleanup = (reason: CloseReason) => void reason;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup("error");
        }
      };
      const onPoke = (...[payload]: BusEvents["poke"]) =>
        send(sseMessage("poke", payload));
      const onPresence = (...[payload]: BusEvents["presence"]) =>
        send(sseMessage("presence", view(payload)));
      const timer = setInterval(
        () => send(": ping\n\n"),
        options.pingMs ?? PING_MS,
      );

      // The retry line tells the browser to connect again after RETRY_MS.
      const maxAge = setTimeout(
        () => close("max_age"),
        options.maxAgeMs ?? MAX_AGE_MS,
      );

      let closed = false;
      openStreams++;
      cleanup = (reason) => {
        if (closed) return;
        closed = true;
        openStreams--;
        clearInterval(timer);
        clearTimeout(maxAge);
        bus.off("poke", onPoke);
        bus.off("presence", onPresence);
        signal.removeEventListener("abort", onAbort);
        options.onClose?.(reason);
      };
      const close = (reason: CloseReason) => {
        cleanup(reason);
        try {
          controller.close();
        } catch {
          // The stream is already closed.
        }
      };
      const onAbort = () => close("client");

      bus.on("poke", onPoke);
      bus.on("presence", onPresence);
      signal.addEventListener("abort", onAbort);
      // The first bytes open the stream at once. Safari waits for 1 KB
      // before it shows streamed content, but EventSource reads each event.
      send(`retry: ${RETRY_MS}\n: connected\n\n`);
      // A new connection gets who is present now.
      send(sseMessage("presence", view(getPresence().snapshot())));
      if (signal.aborted) onAbort();
    },
    cancel() {
      cleanup("client");
    },
  });
}
