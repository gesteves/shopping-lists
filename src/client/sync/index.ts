// The sync engine of this browser, and the functions that the UI calls.
import type { Op } from "@/shared/ops";
import { getClientDb, getMeta } from "../db";
import { presenceStore, startPresence } from "../presence";
import { startRealtime } from "../realtime";
import { installErrorReports, reportError } from "../report";
import { SyncEngine } from "./engine";
import {
  ensureClientId,
  mutateLocal,
  resetForUser,
  type OpRequest,
} from "./local";

export type { OpRequest } from "./local";
export type {
  MergedDetail,
  RejectedDetail,
  SyncState,
  SyncStatus,
} from "./engine";

let engine: SyncEngine | undefined;

export function getSyncEngine(): SyncEngine {
  engine ??= new SyncEngine({
    db: getClientDb(),
    onError: (error) => reportError("sync", error),
  });
  return engine;
}

/** The user of the session, from the server. Null if it is not known. */
async function sessionUserId(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/get-session", {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { id?: string } } | null;
    return body?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * True if sync can start for `userId`. If this browser has the data of a
 * different user, `userId` can come from a page in the cache (#103). Then
 * the session must show `userId` before the data goes: a reset deletes the
 * outbox. If the session does not show it (for example, offline), sync does
 * not start, and the data stays.
 */
async function canStart(userId: string): Promise<boolean> {
  const current = await getMeta(getClientDb(), "userId");
  if (current === undefined || current === userId) return true;
  return (await sessionUserId()) === userId;
}

let stopActive: (() => void) | null = null;
/** The user of the last startSync(). mutate() tags each op with it (#115). */
let syncUser: string | undefined;
/** The first wait before a new user check, and the longest wait. */
const CHECK_RETRY_MS = 5_000;
const MAX_CHECK_RETRY_MS = 5 * 60_000;
/**
 * Resolves when startSync() knows if the local data stays, or when the user
 * check fails. mutate() waits for it: a reset after a write deletes the write
 * if it has a different user. The first page can show
 * before the header starts sync, thus it waits for the first startSync() too,
 * but at most FIRST_START_MS.
 */
const FIRST_START_MS = 15_000;
let firstDecided: () => void = () => {};
let ready: Promise<void> =
  typeof window === "undefined"
    ? Promise.resolve()
    : new Promise((resolve) => {
        firstDecided = resolve;
        setTimeout(resolve, FIRST_START_MS);
      });

/** Stop sync, the realtime stream, and presence (sign-out, #103). */
export function stopSync(): void {
  stopActive?.();
}

/**
 * Start sync, the realtime stream, and presence for the signed-in user. It
 * returns a function that stops them. If a different user used this browser
 * before, and the session shows the new user, the local data is deleted
 * first. If the session cannot show it, it tries again when the browser is
 * online, and on a timer: get-session can fail while the browser is online,
 * and then no `online` event comes (#115). The writes before the check
 * have the new user, thus the reset keeps them.
 */
export function startSync(userId: string): () => void {
  installErrorReports();
  syncUser = userId;
  const stops: (() => void)[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wait = CHECK_RETRY_MS;
  const cancelRetry = () => {
    window.removeEventListener("online", retry);
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = () => {
    stopped = true;
    cancelRetry();
    for (const fn of stops) fn();
    if (stopActive === stop) stopActive = null;
  };
  stopActive = stop;

  const retry = () => {
    cancelRetry();
    void begin();
  };
  const begin = async () => {
    const decided = (async () => {
      if (!(await canStart(userId))) return false;
      if (stopped) return false;
      await resetForUser(getClientDb(), userId);
      return true;
    })();
    const done = decided.then(
      () => undefined,
      () => undefined,
    );
    ready = done;
    void done.then(firstDecided);
    if (!(await decided)) {
      if (stopped) return;
      window.addEventListener("online", retry);
      if (navigator.onLine !== false) {
        timer = setTimeout(retry, wait);
        wait = Math.min(wait * 2, MAX_CHECK_RETRY_MS);
      }
      return;
    }
    const clientId = await ensureClientId(getClientDb());
    if (stopped) return;
    const engine = getSyncEngine();
    stops.push(engine.start());
    stops.push(
      startRealtime({
        onPoke: poke,
        onOpen: poke,
        // Keep only the other people.
        onPresence: (snapshot) =>
          presenceStore.set(
            snapshot?.entries.filter((e) => e.userId !== userId) ?? [],
          ),
        // The EventSource gives no detail: the count only.
        onFailures: (failures) =>
          reportError(
            "realtime",
            Object.assign(new Error(`${failures} failed connections`), {
              name: "EventSource",
            }),
          ),
      }),
    );
    stops.push(startPresence({ clientId }));
  };
  void begin();
  return stop;
}

/**
 * Make a change: apply it to the local data now, add it to the outbox, and
 * sync soon. It works offline. It throws if the op is not valid.
 */
export async function mutate(request: OpRequest): Promise<Op> {
  await ready;
  const op = await mutateLocal(getClientDb(), request, syncUser);
  getSyncEngine().notifyWrite();
  return op;
}

/** The server has changes. The SSE client (#11) calls it. */
export function poke(): void {
  getSyncEngine().poke();
}
