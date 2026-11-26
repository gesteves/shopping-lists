import { describe, expect, it } from "vitest";
import { startRealtime, type VisibilitySource } from "./realtime";

/** A fake EventSource. The test calls emit() for the server. */
class FakeSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeSource.all.push(this);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
  emit(type: string, data?: unknown) {
    if (type === "open") this.readyState = FakeSource.OPEN;
    this.dispatchEvent(
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
}

class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function setup() {
  FakeSource.all = [];
  const doc = new FakeDocument();
  const timers: { fn: () => void; ms: number }[] = [];
  const calls = { pokes: 0, opens: 0 };
  const presence: unknown[] = [];
  const stop = startRealtime({
    onPoke: () => calls.pokes++,
    onOpen: () => calls.opens++,
    onPresence: (s) => presence.push(s),
    EventSource: FakeSource as unknown as typeof EventSource,
    document: doc,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => timers.splice(timers.indexOf(h as never), 1),
  });
  const latest = () => FakeSource.all.at(-1)!;
  return { doc, timers, calls, stop, latest, presence };
}

describe("startRealtime", () => {
  it("syncs on open and on each poke", () => {
    const { calls, latest } = setup();
    expect(latest().url).toBe("/api/events");
    latest().emit("open");
    latest().emit("poke");
    latest().emit("poke");
    expect(calls).toEqual({ opens: 1, pokes: 2 });
  });

  it("closes when the page is hidden and opens when it is visible", () => {
    const { doc, latest } = setup();
    const first = latest();
    doc.set("hidden");
    expect(first.readyState).toBe(FakeSource.CLOSED);
    expect(FakeSource.all).toHaveLength(1);

    doc.set("visible");
    expect(FakeSource.all).toHaveLength(2);
    expect(latest()).not.toBe(first);
  });

  it("lets the browser reconnect after a network error", () => {
    const { timers, latest } = setup();
    latest().emit("error"); // readyState is CONNECTING: the browser retries.
    expect(timers).toHaveLength(0);
    expect(FakeSource.all).toHaveLength(1);
  });

  it("tries again later, with backoff, after the browser gives up", () => {
    const { timers, latest } = setup();
    for (const expected of [5000, 10000, 20000]) {
      latest().readyState = FakeSource.CLOSED;
      latest().emit("error");
      expect(timers.map((t) => t.ms)).toEqual([expected]);
      timers.shift()!.fn();
    }
    expect(FakeSource.all).toHaveLength(4);
    // A good connection resets the backoff.
    latest().emit("open");
    latest().readyState = FakeSource.CLOSED;
    latest().emit("error");
    expect(timers.map((t) => t.ms)).toEqual([5000]);
  });

  it("passes presence on, and clears it when the stream closes", () => {
    const { doc, latest, presence } = setup();
    latest().emit("open");
    latest().emit("presence", { entries: [{ userId: "a" }] });
    expect(presence).toEqual([{ entries: [{ userId: "a" }] }]);
    latest().emit("error");
    doc.set("hidden");
    expect(presence.slice(1)).toEqual([null, null]);
  });

  it("stops everything", () => {
    const { stop, doc, timers, latest } = setup();
    latest().readyState = FakeSource.CLOSED;
    latest().emit("error");
    stop();
    expect(timers).toHaveLength(0);
    doc.set("visible");
    expect(FakeSource.all).toHaveLength(1);
  });
});
