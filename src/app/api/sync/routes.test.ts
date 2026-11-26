// The sync routes need a session. The real session check is mocked here:
// e2e/sync.spec.ts tests it with the server.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  requireApiUser: async () =>
    Response.json({ error: "unauthorized" }, { status: 401 }),
}));

const { POST } = await import("./push/route");
const { GET } = await import("./pull/route");

describe("sync routes without a session", () => {
  it("push gets 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("pull gets 401", async () => {
    const res = await GET(new Request("http://localhost/api/sync/pull"));
    expect(res.status).toBe(401);
  });
});
