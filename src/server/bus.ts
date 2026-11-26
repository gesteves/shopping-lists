// The in-process event bus. applyOps sends a poke after each commit that
// changed rows. The SSE route (#11) sends the events to the clients.
import "server-only";
import { EventEmitter } from "node:events";
import type { PresenceSnapshot } from "@/shared/presence";

export interface BusEvents {
  /** Rows changed. `seq` is the last seq of the commit. */
  poke: [{ seq: number }];
  /** All present devices, after a change (#12). */
  presence: [PresenceSnapshot];
}

// Next.js can load this module more than one time (one copy for each route
// bundle, and again after a dev reload). globalThis keeps one bus for the
// process.
const KEY = Symbol.for("shopping-lists.bus");
const store = globalThis as typeof globalThis & {
  [KEY]?: EventEmitter<BusEvents>;
};

export const bus: EventEmitter<BusEvents> = (store[KEY] ??=
  new EventEmitter<BusEvents>().setMaxListeners(100));
