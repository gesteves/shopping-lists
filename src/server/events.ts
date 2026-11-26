// The SSE stream of GET /api/events (#11). It sends a `poke` event for each
// bus poke, a `presence` event at the start and for each change (#12), and a
// comment every PING_MS. The comments keep the connection
// open: Cloudflare closes a connection that sends nothing for 100 s.
import "server-only";
import { bus, type BusEvents } from "./bus";
import { getPresence } from "./presence";

export const PING_MS = 20_000;
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

/** One SSE message. */
export function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A stream of events until `signal` aborts or the client cancels. It
 * removes its bus listener and its timer at the end.
 */
export function createEventStream(
  signal: AbortSignal,
  options: { pingMs?: number } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const onPoke = (...[payload]: BusEvents["poke"]) =>
        send(sseMessage("poke", payload));
      const onPresence = (...[payload]: BusEvents["presence"]) =>
        send(sseMessage("presence", payload));
      const timer = setInterval(
        () => send(": ping\n\n"),
        options.pingMs ?? PING_MS,
      );

      cleanup = () => {
        clearInterval(timer);
        bus.off("poke", onPoke);
        bus.off("presence", onPresence);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The stream is already closed.
        }
      };

      bus.on("poke", onPoke);
      bus.on("presence", onPresence);
      signal.addEventListener("abort", onAbort);
      // The first bytes open the stream at once. Safari waits for 1 KB
      // before it shows streamed content, but EventSource reads each event.
      send(`retry: ${RETRY_MS}\n: connected\n\n`);
      // A new connection gets who is present now.
      send(sseMessage("presence", getPresence().snapshot()));
      if (signal.aborted) onAbort();
    },
    cancel() {
      cleanup();
    },
  });
}
