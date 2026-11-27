import { getIP } from "@better-auth/core/utils/ip";
import { describe, expect, it } from "vitest";
import { IP_ADDRESS_OPTIONS } from "./client-ip";

function ip(forwarded: string) {
  return getIP(new Headers({ "x-forwarded-for": forwarded }), {
    advanced: { ipAddress: IP_ADDRESS_OPTIONS },
  });
}

describe("the client IP behind Cloudflare and Fly", () => {
  it("is the address before the Cloudflare hop", () => {
    expect(ip("203.0.113.5, 172.64.10.1")).toBe("203.0.113.5");
    expect(ip("2001:db8::1, 2606:4700::5")).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0000",
    );
  });

  it("does not trust an address that the client sends", () => {
    // Cloudflare adds to a header from the client.
    expect(ip("198.51.100.7, 203.0.113.5, 172.64.10.1")).toBe("203.0.113.5");
    // Direct to Fly: Fly adds the real address.
    expect(ip("198.51.100.7, 203.0.113.9")).toBe("203.0.113.9");
  });
});
