import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/client";
import { createTestDb } from "@/test/db";
import { captureLogs } from "@/test/logs";
import { healthResponse, resetHealthState } from "./health";
import {
  MAX_LAG_MS,
  ReplicationMonitor,
  parseMetrics,
  replicationStatus,
} from "./replication";

const URL = "http://127.0.0.1:9090/metrics";

/** Metrics text as Litestream 0.5 gives it. */
function metrics(txid: number, puts?: number) {
  return [
    "# HELP litestream_txid The current transaction ID",
    "# TYPE litestream_txid gauge",
    `litestream_txid{db="/data/shopping-lists.db"} ${txid}`,
    `litestream_replica_operation_total{operation="LIST",replica_type="s3"} 4`,
    ...(puts === undefined
      ? []
      : [
          `litestream_replica_operation_total{operation="PUT",replica_type="s3"} ${puts}`,
        ]),
    "",
  ].join("\n");
}

/** A fake metrics endpoint. `null` is a failed request. */
function endpoint() {
  const state = { body: null as string | null };
  const fetcher: typeof fetch = async () =>
    state.body === null
      ? Promise.reject(new TypeError("connection refused"))
      : new Response(state.body);
  return { state, fetcher };
}

describe("parseMetrics", () => {
  it("reads the txid and the PUT count", () => {
    expect(parseMetrics(metrics(12, 7))).toEqual({ txid: 12, puts: 7 });
  });

  it("counts no PUT line as 0", () => {
    expect(parseMetrics(metrics(3))).toEqual({ txid: 3, puts: 0 });
  });

  it("gives null without a txid", () => {
    expect(parseMetrics("go_goroutines 10\n")).toBeNull();
  });
});

describe("ReplicationMonitor", () => {
  it("is late when the txid goes up and no upload follows", () => {
    const monitor = new ReplicationMonitor();
    expect(monitor.check({ txid: 1, puts: 1 }, 0).ok).toBe(true);
    expect(monitor.check({ txid: 2, puts: 1 }, 1000)).toEqual({
      ok: true,
      lagMs: 0,
    });
    expect(monitor.check({ txid: 2, puts: 1 }, 1000 + MAX_LAG_MS).ok).toBe(
      true,
    );
    expect(
      monitor.check({ txid: 3, puts: 1 }, 2000 + MAX_LAG_MS),
    ).toMatchObject({ ok: false, reason: "late" });
    // An upload: replication is good again.
    expect(monitor.check({ txid: 3, puts: 2 }, 3000 + MAX_LAG_MS).ok).toBe(
      true,
    );
  });

  it("is not late with no writes", () => {
    const monitor = new ReplicationMonitor();
    monitor.check({ txid: 5, puts: 5 }, 0);
    expect(monitor.check({ txid: 5, puts: 5 }, 10 * MAX_LAG_MS).ok).toBe(true);
  });

  it("starts again when Litestream starts again", () => {
    const monitor = new ReplicationMonitor();
    monitor.check({ txid: 5, puts: 5 }, 0);
    monitor.check({ txid: 6, puts: 5 }, 1);
    expect(monitor.check({ txid: 1, puts: 0 }, 2 * MAX_LAG_MS).ok).toBe(true);
  });
});

describe("healthResponse", () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.$client.close());

  async function check(
    monitor: ReplicationMonitor,
    fetcher: typeof fetch,
    now: number,
  ) {
    const res = await healthResponse({
      db,
      replication: true,
      status: () =>
        replicationStatus({ url: URL, fetch: fetcher, monitor, now }),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    return { status: res.status, body: await res.json() };
  }

  it("gives 200 with good metrics", async () => {
    const { state, fetcher } = endpoint();
    state.body = metrics(10, 10);
    const result = await check(new ReplicationMonitor(), fetcher, 0);
    expect(result).toEqual({
      status: 200,
      body: { ok: true, replication: { ok: true, lagMs: 0 } },
    });
  });

  it("gives 503 when replication is late", async () => {
    const { state, fetcher } = endpoint();
    const monitor = new ReplicationMonitor();
    state.body = metrics(10, 10);
    await check(monitor, fetcher, 0);
    state.body = metrics(11, 10);
    expect((await check(monitor, fetcher, 1000)).status).toBe(200);
    const late = await check(monitor, fetcher, 2000 + MAX_LAG_MS);
    expect(late.status).toBe(503);
    expect(late.body.replication).toMatchObject({ ok: false, reason: "late" });
  });

  it("gives 503 when it cannot read the metrics", async () => {
    const { fetcher } = endpoint();
    const result = await check(new ReplicationMonitor(), fetcher, 0);
    expect(result).toEqual({
      status: 503,
      body: { ok: false, replication: { ok: false, reason: "no_metrics" } },
    });
  });

  it("skips the replication check without a metrics URL", async () => {
    const res = await healthResponse({
      db,
      replication: true,
      status: () => replicationStatus({ url: "" }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("checks only the database for the live check", async () => {
    const res = await healthResponse({
      db,
      status: () => Promise.reject(new Error("not called")),
    });
    expect(res.status).toBe(200);
    db.$client.close();
    expect((await healthResponse({ db })).status).toBe(503);
    db = createTestDb();
  });
});

describe("health log (#147)", () => {
  afterEach(() => {
    resetHealthState();
    vi.restoreAllMocks();
  });

  it("logs only a change of state", async () => {
    resetHealthState();
    const logs = captureLogs();
    const db = createTestDb();
    let status: { ok: false; reason: "no_metrics" } | null = {
      ok: false,
      reason: "no_metrics",
    };
    const full = () =>
      healthResponse({ db, replication: true, status: async () => status });
    await full();
    await full();
    await healthResponse({ db });
    status = null;
    await full();
    await full();
    db.$client.close();
    await healthResponse({ db });
    expect(logs.lines).toEqual([
      "warn [health] down check=full reason=no_metrics",
      "info [health] up check=full",
      "warn [health] down check=live reason=db err=TypeError",
    ]);
  });
});
