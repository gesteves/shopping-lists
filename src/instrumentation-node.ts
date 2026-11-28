// The start of the server in the Node.js runtime. src/instrumentation.ts
// imports it only in that runtime: the Edge build does not get this code
// (process.exit, SQLite). See the instrumentation guide of Next.js.
export async function registerNode() {
  const { log, logLevel } = await import("@/server/log");
  // The first line after each start. The workers keep their state in
  // memory, thus a start also starts their waits again.
  log.info("boot", "start", {
    version: process.env.APP_VERSION || "dev",
    node: process.versions.node.split(".")[0],
    log: logLevel(),
  });
  // Apply new migrations at boot. Do not use a Fly release_command: that
  // machine does not have the volume.
  const { runMigrations } = await import("@/db/migrate");
  const started = performance.now();
  try {
    const applied = runMigrations();
    log.info("boot", "migrations", {
      applied,
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    // Next.js logs a throw here, and the server then starts with no
    // migrations (#119). Stop the process: Litestream then stops too, and
    // the machine does not start on a bad database.
    log.error("boot", "migrations failed, the server stops", {}, error);
    process.exit(1);
  }
  // Send notifications for activity (#16). Rows that a restart left are
  // sent at the next tick.
  const { startNotifier } = await import("@/server/notify/worker");
  const { createSummarizer } = await import("@/server/notify/summarize");
  // Claude writes the text of each burst, also for one change (#89).
  startNotifier({ summarize: createSummarizer() });
  // Claude writes a summary of the unchecked items of each list. There is
  // no worker without ANTHROPIC_API_KEY: the lists page shows the count.
  const { createListSummarizer } = await import("@/server/summary/summarize");
  const { startSummaryWorker } = await import("@/server/summary/worker");
  const summarizeList = createListSummarizer();
  if (summarizeList) startSummaryWorker({ summarize: summarizeList });
  // Delete old tombstones each day (#20).
  const { startPurger } = await import("@/server/purge");
  startPurger();
  const { getVapidConfig } = await import("@/server/push");
  log.info("boot", "workers", {
    notify: "on",
    summary: summarizeList ? "on" : "off",
    push: getVapidConfig() ? "on" : "off",
    purge: "on",
  });
}
