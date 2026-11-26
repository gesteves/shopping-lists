// Hybrid logical clock (HLC). Each op gets an HLC timestamp. The merge in
// applyOps (#5) keeps the value with the larger timestamp, field by field.
//
// A timestamp has three parts:
//   - wall: milliseconds since the epoch. It never goes back.
//   - counter: it orders events in the same millisecond.
//   - node: the client ID. Two equal (wall, counter) pairs sort by node.
//
// The serialized form has a fixed width before the node. Thus a string
// comparison gives the same order as compare(). The database and IndexedDB
// can keep the strings and compare them directly.
//
// This file must import nothing. The browser and the server both use it.

export interface Hlc {
  wall: number;
  counter: number;
  node: string;
}

/** The counter is 4 hex digits. */
export const MAX_COUNTER = 0xffff;

/**
 * receive() refuses a remote time that is more than this far in the future.
 * Without a limit, one device with a bad clock wins every merge.
 */
export const MAX_DRIFT_MS = 5 * 60_000;

const WALL_DIGITS = 15;
const MAX_WALL = 10 ** WALL_DIGITS - 1;

/** A node ID: letters, digits, "_" and "-". A UUID is a valid node ID. */
export const NODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A serialized HLC: 15 decimal digits, "-", 4 hex digits, "-", the node. */
export const HLC_PATTERN = /^(\d{15})-([0-9a-f]{4})-([A-Za-z0-9_-]{1,64})$/;

export class HlcError extends Error {
  override name = "HlcError";
}

function check(h: Hlc): Hlc {
  if (!Number.isSafeInteger(h.wall) || h.wall < 0 || h.wall > MAX_WALL) {
    throw new HlcError(`Bad HLC wall time: ${h.wall}`);
  }
  if (
    !Number.isInteger(h.counter) ||
    h.counter < 0 ||
    h.counter > MAX_COUNTER
  ) {
    throw new HlcError(`Bad HLC counter: ${h.counter}`);
  }
  if (!NODE_PATTERN.test(h.node)) {
    throw new HlcError(`Bad HLC node: ${JSON.stringify(h.node)}`);
  }
  return h;
}

/** If the counter is full, go to the next millisecond. Order stays correct. */
function next(wall: number, counter: number, node: string): Hlc {
  if (counter > MAX_COUNTER) return check({ wall: wall + 1, counter: 0, node });
  return check({ wall, counter, node });
}

/** The first timestamp of a node, before any event. */
export function zero(node: string): Hlc {
  return check({ wall: 0, counter: 0, node });
}

/**
 * The timestamp for a new local event. It is always larger than `prev`, also
 * when the physical clock (`now`) goes back.
 */
export function tick(prev: Hlc, now: number): Hlc {
  const wall = Math.max(prev.wall, Math.floor(now));
  const counter = wall === prev.wall ? prev.counter + 1 : 0;
  return next(wall, counter, prev.node);
}

/**
 * Update the local clock after a remote timestamp. The result is larger than
 * both `local` and `remote`, and it keeps the local node.
 *
 * It throws HlcError if `remote` is more than `maxDriftMs` after `now`.
 */
export function receive(
  local: Hlc,
  remote: Hlc,
  now: number,
  maxDriftMs: number = MAX_DRIFT_MS,
): Hlc {
  const physical = Math.floor(now);
  if (remote.wall - physical > maxDriftMs) {
    throw new HlcError(
      `Remote clock is ${remote.wall - physical} ms ahead (limit ${maxDriftMs} ms)`,
    );
  }
  const wall = Math.max(local.wall, remote.wall, physical);
  let counter: number;
  if (wall === local.wall && wall === remote.wall) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wall === local.wall) {
    counter = local.counter + 1;
  } else if (wall === remote.wall) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return next(wall, counter, local.node);
}

/** -1 if a is before b, 1 if a is after b, 0 if they are equal. */
export function compare(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

export function serialize(h: Hlc): string {
  check(h);
  const wall = String(h.wall).padStart(WALL_DIGITS, "0");
  const counter = h.counter.toString(16).padStart(4, "0");
  return `${wall}-${counter}-${h.node}`;
}

/** Parse a serialized HLC. It throws HlcError if the string is not valid. */
export function parse(s: string): Hlc {
  const m = HLC_PATTERN.exec(s);
  if (!m) throw new HlcError(`Bad HLC string: ${JSON.stringify(s)}`);
  return check({ wall: Number(m[1]), counter: parseInt(m[2], 16), node: m[3] });
}

export function isHlc(s: string): boolean {
  try {
    parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * A clock with state, for one node. `now()` gives the timestamp for a new
 * local op. Call `receive()` with each remote timestamp (for example, each
 * clock in a sync pull), so that the next local op sorts after it.
 */
export class HlcClock {
  #last: Hlc;
  readonly #physical: () => number;

  /**
   * @param node the client ID.
   * @param last the last timestamp of this node, if it is stored. Without it,
   *   a fast restart in the same millisecond can give a timestamp again.
   * @param physical the physical clock. Tests can give a fake clock.
   */
  constructor(node: string, last?: string, physical: () => number = Date.now) {
    this.#physical = physical;
    this.#last = last === undefined ? zero(node) : { ...parse(last), node };
    check(this.#last);
  }

  /** The last timestamp, serialized. Store it to keep the clock monotonic. */
  get last(): string {
    return serialize(this.#last);
  }

  now(): string {
    this.#last = tick(this.#last, this.#physical());
    return serialize(this.#last);
  }

  /** It throws HlcError if `remote` is not valid or is too far ahead. */
  receive(remote: string, maxDriftMs: number = MAX_DRIFT_MS): void {
    this.#last = receive(
      this.#last,
      parse(remote),
      this.#physical(),
      maxDriftMs,
    );
  }
}
