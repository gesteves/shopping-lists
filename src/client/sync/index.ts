// The sync engine of this browser, and the functions that the UI calls.
import type { Op } from "@/shared/ops";
import { getClientDb } from "../db";
import { SyncEngine } from "./engine";
import { mutateLocal, resetForUser, type OpRequest } from "./local";

export type { OpRequest } from "./local";
export type { RejectedDetail, SyncState, SyncStatus } from "./engine";

let engine: SyncEngine | undefined;

export function getSyncEngine(): SyncEngine {
  engine ??= new SyncEngine({ db: getClientDb() });
  return engine;
}

/**
 * Start sync for the signed-in user. It returns a function that stops the
 * triggers. If a different user used this browser before, the local data is
 * deleted first.
 */
export function startSync(userId: string): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  void resetForUser(getClientDb(), userId).then(() => {
    if (!stopped) stop = getSyncEngine().start();
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

/**
 * Make a change: apply it to the local data now, add it to the outbox, and
 * sync soon. It works offline. It throws if the op is not valid.
 */
export async function mutate(request: OpRequest): Promise<Op> {
  const op = await mutateLocal(getClientDb(), request);
  getSyncEngine().notifyWrite();
  return op;
}

/** The server has changes. The SSE client (#11) calls it. */
export function poke(): void {
  getSyncEngine().poke();
}
