// Next.js calls `register` one time at server start, before the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Apply new migrations at boot. Do not use a Fly release_command: that
  // machine does not have the volume.
  const { runMigrations } = await import("@/db/migrate");
  runMigrations();
  // Send notifications for activity (#16). Rows that a restart left are
  // sent at the next tick.
  const { startNotifier } = await import("@/server/notify/worker");
  const { createSummarizer } = await import("@/server/notify/summarize");
  // Claude writes the text for more than one change (#17).
  startNotifier({ summarize: createSummarizer() });
}
