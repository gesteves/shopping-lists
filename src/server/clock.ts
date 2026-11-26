// The HLC clock of the server. applyOps gives it each op HLC, thus an op
// that the server makes (for example, from MCP in #19) sorts after them.
import "server-only";
import { HlcClock } from "@/shared/hlc";

/** The clientId and HLC node of the ops that the server makes. */
export const SERVER_NODE = "server";

const KEY = Symbol.for("shopping-lists.clock");
const store = globalThis as typeof globalThis & { [KEY]?: HlcClock };

export function getServerClock(): HlcClock {
  return (store[KEY] ??= new HlcClock(SERVER_NODE));
}
