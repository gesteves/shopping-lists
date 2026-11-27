import { afterEach, describe, expect, it, vi } from "vitest";

const runMigrations = vi.fn();
vi.mock("@/db/migrate", () => ({ runMigrations }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("register", () => {
  it("stops the process when a migration fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    runMigrations.mockImplementation(() => {
      throw new Error("Foreign key check failed after the migrations");
    });
    // The real exit stops the test run. This one stops register() only.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
