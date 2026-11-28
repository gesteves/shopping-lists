// Get the log lines of a test. It stops the output of the four console
// methods. Call vi.restoreAllMocks() after the test.
import { vi } from "vitest";

export function captureLogs() {
  const lines: string[] = [];
  for (const method of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return {
    lines,
    /** The lines that start with this text, for example "info [sync] push". */
    find: (prefix: string) => lines.filter((line) => line.startsWith(prefix)),
    text: () => lines.join("\n"),
  };
}
