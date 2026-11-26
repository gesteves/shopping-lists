import { describe, expect, it } from "vitest";
import {
  HlcClock,
  HlcError,
  MAX_COUNTER,
  MAX_DRIFT_MS,
  compare,
  parse,
  receive,
  serialize,
  tick,
  zero,
  type Hlc,
} from "./hlc";

const A = "aaaaaaaa-0000-4000-8000-000000000000";
const B = "bbbbbbbb-0000-4000-8000-000000000000";
const T = 1_764_000_000_000;

/** A physical clock that the test sets. */
function fakeClock(start: number) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe("tick", () => {
  it("uses the physical time when it moves forward", () => {
    expect(tick({ wall: T, counter: 5, node: A }, T + 10)).toEqual({
      wall: T + 10,
      counter: 0,
      node: A,
    });
  });

  it("adds to the counter in the same millisecond", () => {
    expect(tick({ wall: T, counter: 5, node: A }, T)).toEqual({
      wall: T,
      counter: 6,
      node: A,
    });
  });

  it("stays monotonic when the physical clock goes back", () => {
    const prev = { wall: T, counter: 2, node: A };
    const next = tick(prev, T - 60_000);
    expect(next).toEqual({ wall: T, counter: 3, node: A });
    expect(compare(next, prev)).toBe(1);
  });

  it("goes to the next millisecond when the counter is full", () => {
    const next = tick({ wall: T, counter: MAX_COUNTER, node: A }, T);
    expect(next).toEqual({ wall: T + 1, counter: 0, node: A });
  });
});

describe("HlcClock", () => {
  it("gives strictly increasing timestamps, also with a frozen clock", () => {
    const physical = fakeClock(T);
    const clock = new HlcClock(A, undefined, physical.now);
    const out: string[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i % 100 === 0) physical.set(T - i); // The clock goes back.
      out.push(clock.now());
    }
    for (let i = 1; i < out.length; i++) {
      expect(compare(parse(out[i - 1]), parse(out[i]))).toBe(-1);
      expect(out[i - 1] < out[i]).toBe(true);
    }
  });

  it("continues after the last stored timestamp", () => {
    const physical = fakeClock(T);
    const first = new HlcClock(A, undefined, physical.now);
    first.now();
    const last = first.now();

    // A restart in the same millisecond.
    const again = new HlcClock(A, last, physical.now);
    expect(again.now() > last).toBe(true);
  });

  it("sorts after a remote timestamp from a clock that is ahead", () => {
    const physical = fakeClock(T);
    const behind = new HlcClock(A, undefined, physical.now);
    const remote = serialize({ wall: T + 60_000, counter: 7, node: B });

    behind.receive(remote);
    const next = behind.now();
    expect(compare(parse(next), parse(remote))).toBe(1);
    expect(parse(next).node).toBe(A);
  });

  it("refuses a remote timestamp that is too far ahead", () => {
    const physical = fakeClock(T);
    const clock = new HlcClock(A, undefined, physical.now);
    const before = clock.last;
    const far = serialize({ wall: T + MAX_DRIFT_MS + 1, counter: 0, node: B });

    expect(() => clock.receive(far)).toThrow(HlcError);
    expect(clock.last).toBe(before);
    expect(() => clock.receive("not an hlc")).toThrow(HlcError);
  });
});

describe("receive", () => {
  const local: Hlc = { wall: T, counter: 3, node: A };

  it("uses the physical time when it is the largest", () => {
    const remote = { wall: T - 5, counter: 9, node: B };
    expect(receive(local, remote, T + 100)).toEqual({
      wall: T + 100,
      counter: 0,
      node: A,
    });
  });

  it("uses the larger counter when the wall times are equal", () => {
    const remote = { wall: T, counter: 8, node: B };
    expect(receive(local, remote, T - 1000)).toEqual({
      wall: T,
      counter: 9,
      node: A,
    });
  });

  it("uses the remote time when it is ahead", () => {
    const remote = { wall: T + 500, counter: 2, node: B };
    expect(receive(local, remote, T)).toEqual({
      wall: T + 500,
      counter: 3,
      node: A,
    });
  });

  it("uses the local time when it is ahead", () => {
    const remote = { wall: T - 500, counter: 40, node: B };
    expect(receive(local, remote, T - 1000)).toEqual({
      wall: T,
      counter: 4,
      node: A,
    });
  });

  it("accepts a remote time at the drift limit", () => {
    const remote = { wall: T + 1000, counter: 0, node: B };
    expect(receive(local, remote, T, 1000).wall).toBe(T + 1000);
    expect(() => receive(local, remote, T, 999)).toThrow(HlcError);
  });
});

describe("compare", () => {
  it("orders by wall, then counter, then node", () => {
    const sorted: Hlc[] = [
      { wall: T, counter: 0, node: A },
      { wall: T, counter: 0, node: B },
      { wall: T, counter: 1, node: A },
      { wall: T + 1, counter: 0, node: A },
    ];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = 0; j < sorted.length; j++) {
        const expected = Math.sign(i - j);
        expect(compare(sorted[i], sorted[j])).toBe(expected);
        // The strings sort the same way (code unit order, as in SQLite).
        const [x, y] = [serialize(sorted[i]), serialize(sorted[j])];
        expect(x < y ? -1 : x > y ? 1 : 0).toBe(expected);
      }
    }
  });

  it("breaks a tie on the client ID", () => {
    const a = { wall: T, counter: 4, node: A };
    const b = { wall: T, counter: 4, node: B };
    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, { ...a })).toBe(0);
  });
});

describe("serialize and parse", () => {
  it("round-trip", () => {
    const cases: Hlc[] = [
      zero("server"),
      { wall: T, counter: 0, node: A },
      { wall: T, counter: MAX_COUNTER, node: B },
      { wall: 10 ** 15 - 1, counter: 1, node: "x" },
    ];
    for (const h of cases) {
      const s = serialize(h);
      expect(parse(s)).toEqual(h);
      expect(serialize(parse(s))).toBe(s);
    }
  });

  it("uses a fixed-width form", () => {
    expect(serialize({ wall: T, counter: 26, node: A })).toBe(
      `00${T}-001a-${A}`,
    );
  });

  it("refuses bad strings", () => {
    for (const s of [
      "",
      `${T}-0000-${A}`, // A short wall.
      `00${T}-00000-${A}`, // A long counter.
      `00${T}-001A-${A}`, // Upper-case hex.
      `00${T}-0000-`, // No node.
      `00${T}-0000-a b`, // A space in the node.
      `00${T}-0000-${"n".repeat(65)}`, // A long node.
    ]) {
      expect(() => parse(s), s).toThrow(HlcError);
    }
  });

  it("refuses bad values", () => {
    expect(() => serialize({ wall: -1, counter: 0, node: A })).toThrow(
      HlcError,
    );
    expect(() => serialize({ wall: 1.5, counter: 0, node: A })).toThrow(
      HlcError,
    );
    expect(() =>
      serialize({ wall: T, counter: MAX_COUNTER + 1, node: A }),
    ).toThrow(HlcError);
    expect(() => serialize({ wall: T, counter: 0, node: "" })).toThrow(
      HlcError,
    );
  });
});
