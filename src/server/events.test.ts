import { afterEach, describe, expect, it } from "vitest";
import { bus } from "./bus";
import { createEventStream } from "./events";

const decoder = new TextDecoder();
let controller: AbortController;

afterEach(() => controller?.abort());

async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value, done } = await reader.read();
  return done ? null : decoder.decode(value);
}

describe("createEventStream", () => {
  it("opens with the retry time, then sends each poke", async () => {
    controller = new AbortController();
    const reader = createEventStream(controller.signal).getReader();
    expect(await read(reader)).toBe("retry: 3000\n: connected\n\n");
    expect(await read(reader)).toMatch(/^event: presence\ndata: \{"entries":/);

    bus.emit("poke", { seq: 7 });
    expect(await read(reader)).toBe('event: poke\ndata: {"seq":7}\n\n');
  });

  it("sends a ping comment on an interval", async () => {
    controller = new AbortController();
    const reader = createEventStream(controller.signal, {
      pingMs: 5,
    }).getReader();
    await read(reader);
    await read(reader);
    expect(await read(reader)).toBe(": ping\n\n");
  });

  it("sends each presence change", async () => {
    controller = new AbortController();
    const reader = createEventStream(controller.signal).getReader();
    await read(reader);
    await read(reader);
    bus.emit("presence", { entries: [] });
    expect(await read(reader)).toBe(
      'event: presence\ndata: {"entries":[]}\n\n',
    );
  });

  it("closes and removes its listener when the request ends", async () => {
    controller = new AbortController();
    const before = bus.listenerCount("poke");
    const reader = createEventStream(controller.signal).getReader();
    await read(reader);
    expect(bus.listenerCount("poke")).toBe(before + 1);

    controller.abort();
    // The presence snapshot was queued before the end.
    expect(await read(reader)).toMatch(/^event: presence/);
    expect(await read(reader)).toBeNull();
    expect(bus.listenerCount("poke")).toBe(before);
  });

  it("closes at the maximum age", async () => {
    controller = new AbortController();
    const before = bus.listenerCount("poke");
    const reader = createEventStream(controller.signal, {
      maxAgeMs: 10,
    }).getReader();
    await read(reader);
    await read(reader);
    expect(await read(reader)).toBeNull();
    expect(bus.listenerCount("poke")).toBe(before);
  });

  it("removes its listener when the client cancels", async () => {
    controller = new AbortController();
    const before = bus.listenerCount("poke");
    const reader = createEventStream(controller.signal).getReader();
    await read(reader);
    await reader.cancel();
    expect(bus.listenerCount("poke")).toBe(before);
  });
});
