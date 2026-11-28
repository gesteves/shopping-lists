// The server log (#147). One line for each event:
//   <level> [<area>] <event> key=value …
// Fly adds the time, the region, and the machine. The rules (what to log,
// and what never to log) are in "Logging" in docs/PLAN.md.
//
// This module has no "server-only" import, because `npm run db:migrate`
// runs outside Next.js. Do not import it in client code.

export type Level = "debug" | "info" | "warn" | "error";

export type Area =
  | "boot"
  | "sync"
  | "events"
  | "presence"
  | "auth"
  | "mcp"
  | "push"
  | "notify"
  | "summary"
  | "claude"
  | "purge"
  | "health"
  | "request"
  | "client";

/**
 * The keys that a line can have. The list is closed on purpose: a key for
 * personal data (an email, a name, a note) must not get in by accident.
 * Before you add a key, read the privacy rules in docs/PLAN.md.
 */
export type FieldKey =
  // IDs.
  | "user"
  | "actor"
  | "client"
  | "list"
  | "device"
  | "request"
  | "digest"
  // Counts.
  | "ops"
  | "applied"
  | "duplicate"
  | "rejected"
  | "lists"
  | "items"
  | "events"
  | "recipients"
  | "devices"
  | "sent"
  | "removed"
  | "failed"
  | "failures"
  | "count"
  | "issues"
  | "open"
  | "processed"
  | "tombstoned"
  | "in"
  | "out"
  // Sync cursors.
  | "since"
  | "cursor"
  | "seq"
  | "more"
  | "reset"
  // Times, in ms or in s (wait, claude, total, quiet).
  | "ms"
  | "lag"
  | "wait"
  | "claude"
  | "total"
  | "quiet"
  // Codes and enums.
  | "status"
  | "reason"
  | "reasons"
  | "result"
  | "code"
  | "via"
  | "ready"
  | "for"
  | "model"
  | "stop"
  | "fallback"
  | "grant"
  | "provider"
  | "tool"
  | "method"
  | "check"
  | "type"
  | "area"
  | "err"
  | "host"
  | "route"
  | "page"
  | "msg"
  // The server and its workers.
  | "version"
  | "node"
  | "log"
  | "notify"
  | "summary"
  | "push"
  | "purge";

export type Value = string | number | boolean | null | undefined;
export type Fields = Partial<Record<FieldKey, Value>>;

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** A string value longer than this is cut. */
export const MAX_VALUE = 120;

let warnedLevel: string | undefined;

/** The level from LOG_LEVEL. Not set or a bad value gives "info". */
export function logLevel(value = process.env.LOG_LEVEL): Level {
  const level = value?.trim().toLowerCase();
  if (!level) return "info";
  if (Object.hasOwn(RANK, level)) return level as Level;
  if (warnedLevel !== value) {
    warnedLevel = value;
    console.warn(formatLine("warn", "boot", "bad LOG_LEVEL", { log: "info" }));
  }
  return "info";
}

function formatValue(value: Exclude<Value, undefined>): string {
  if (value === null) return "-";
  if (typeof value !== "string") return String(value);
  const cut =
    value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
  return cut === "" || /[\s="\\]/.test(cut) ? JSON.stringify(cut) : cut;
}

/** One line, with the keys in the given order. Undefined values are skipped. */
export function formatLine(
  level: Level,
  area: Area,
  event: string,
  fields: Fields = {},
): string {
  let line = `${level} [${area}] ${event}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line += ` ${key}=${formatValue(value as Exclude<Value, undefined>)}`;
  }
  return line;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return error === null ? "null" : typeof error;
}

function write(
  level: Level,
  area: Area,
  event: string,
  fields?: Fields,
  error?: unknown,
) {
  // A log line never makes the caller fail.
  try {
    if (RANK[level] < RANK[logLevel()]) return;
    let line = formatLine(level, area, event, {
      ...fields,
      ...(error === undefined ? {} : { err: errorName(error) }),
    });
    // Only an error line has the message and the stack: an unexpected
    // exception cannot be found without them.
    if (level === "error" && error instanceof Error && error.stack) {
      line += `\n${error.stack}`;
    } else if (level === "error" && error !== undefined) {
      line += `\n${String(error)}`;
    }
    console[level](line);
  } catch {
    // Nothing: no line is better than a crash.
  }
}

export const log = {
  debug: (area: Area, event: string, fields?: Fields) =>
    write("debug", area, event, fields),
  info: (area: Area, event: string, fields?: Fields) =>
    write("info", area, event, fields),
  /** A handled problem. An error gives only its name (`err=`). */
  warn: (area: Area, event: string, fields?: Fields, error?: unknown) =>
    write("warn", area, event, fields, error),
  /** An unexpected exception. It writes the message and the stack. */
  error: (area: Area, event: string, fields?: Fields, error?: unknown) =>
    write("error", area, event, fields, error),
};

/** The time since `started`, in ms. */
export function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/** Replace email addresses in a text that is not ours (Better Auth). */
export function scrub(text: string): string {
  return text.replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[^\s@"'<>()]+/g, "<email>");
}
