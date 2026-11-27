// The replication check of /api/health (#102). Litestream serves its metrics
// on localhost (`addr` in litestream.yml). Litestream 0.5 has no metric for
// the time of the last upload. Thus this module compares two values at each
// check:
//   - `litestream_txid`: the local transaction ID. It goes up after a write.
//   - `litestream_replica_operation_total{operation="PUT"}`: the uploads.
// If the txid goes up and no upload follows, replication is late from that
// check. Litestream uploads each change in about one second.
import "server-only";

/** Replication that is late by more than this gives 503. */
export const MAX_LAG_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 2000;

export interface Sample {
  txid: number;
  puts: number;
}

export type ReplicationStatus =
  | { ok: true; lagMs: number }
  | { ok: false; reason: "late"; lagMs: number }
  | { ok: false; reason: "no_metrics" };

/**
 * The values from the Prometheus text format, or null if there is no
 * `litestream_txid` line. Before the first upload, Litestream sends no PUT
 * line: that is 0.
 */
export function parseMetrics(text: string): Sample | null {
  let txid: number | null = null;
  let puts = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const match = /^(\w+)(\{[^}]*\})?\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const [, name, labels = "", raw] = match;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (name === "litestream_txid") txid = Math.max(txid ?? 0, value);
    if (
      name === "litestream_replica_operation_total" &&
      /operation="PUT"/.test(labels)
    ) {
      puts += value;
    }
  }
  return txid === null ? null : { txid, puts };
}

/** It keeps the last sample and the time from which replication is late. */
export class ReplicationMonitor {
  #last: Sample | null = null;
  #lateSince: number | null = null;

  check(sample: Sample | null, now: number): ReplicationStatus {
    if (!sample) return { ok: false, reason: "no_metrics" };
    const last = this.#last;
    this.#last = sample;
    if (!last || sample.puts < last.puts || sample.txid < last.txid) {
      // The first check, or Litestream started again.
      this.#lateSince = null;
    } else if (sample.puts > last.puts) {
      this.#lateSince = null;
    } else if (sample.txid > last.txid) {
      this.#lateSince ??= now;
    }
    const lagMs = this.#lateSince === null ? 0 : now - this.#lateSince;
    return lagMs > MAX_LAG_MS
      ? { ok: false, reason: "late", lagMs }
      : { ok: true, lagMs };
  }
}

const KEY = Symbol.for("shopping-lists.replication");
const store = globalThis as typeof globalThis & {
  [KEY]?: ReplicationMonitor;
};

/** Read the metrics. Null if they are not available. */
export async function fetchSample(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Sample | null> {
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseMetrics(await res.text());
  } catch {
    return null;
  }
}

/**
 * The replication status, or null if there is no check: without
 * LITESTREAM_METRICS_URL (dev, e2e). The image sets it.
 */
export async function replicationStatus(
  options: {
    url?: string;
    fetch?: typeof fetch;
    monitor?: ReplicationMonitor;
    now?: number;
  } = {},
): Promise<ReplicationStatus | null> {
  const url = options.url ?? process.env.LITESTREAM_METRICS_URL;
  if (!url) return null;
  const monitor = options.monitor ?? (store[KEY] ??= new ReplicationMonitor());
  const sample = await fetchSample(url, options.fetch);
  return monitor.check(sample, options.now ?? Date.now());
}
