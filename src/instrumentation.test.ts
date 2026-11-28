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

describe("onRequestError", () => {
  it("logs the route template and the stack, never the path or headers", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onRequestError } = await import("./instrumentation");
    await onRequestError(
      Object.assign(new Error("boom"), { digest: "123" }),
      {
        path: "/api/sync/pull?since=4&name=Milk",
        method: "GET",
        headers: { cookie: "better-auth.session_token=secret" },
      },
      {
        routerKind: "App Router",
        routePath: "/api/sync/pull",
        routeType: "route",
        renderSource: undefined,
        revalidateReason: undefined,
      } as never,
    );
    const line = String(error.mock.calls[0][0]);
    expect(line).toMatch(
      /^error \[request\] failed method=GET route=\/api\/sync\/pull type=route digest=123 err=Error\nError: boom\n/,
    );
    expect(line).not.toMatch(/since=|Milk|secret/);
  });
});
