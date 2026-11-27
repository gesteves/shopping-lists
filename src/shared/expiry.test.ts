import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY_MS,
  EXPIRE_AFTER_DAYS,
  daysLeft,
  expiresAt,
  expiryVariant,
  isOlder,
} from "./expiry";

// Local calendar days depend on the time zone. Fix it for these tests.
const previousTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Denver";
});
afterAll(() => {
  process.env.TZ = previousTz;
});

/** A local time in the fixed zone. */
function local(y: number, m: number, d: number, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

describe("daysLeft", () => {
  it("counts local calendar days, not 24-hour periods", () => {
    // A delete on Wednesday 2026-12-02 at 11 pm.
    const at = local(2026, 12, 2, 23);
    expect(daysLeft(at, local(2026, 12, 1, 0, 1))).toBe(1);
    expect(daysLeft(at, local(2026, 12, 1, 23, 59))).toBe(1);
    expect(daysLeft(at, local(2026, 12, 2, 0, 1))).toBe(0);
    expect(daysLeft(at, local(2026, 11, 30, 23, 59))).toBe(2);
  });

  it("is right across a DST change", () => {
    // DST ends on 2026-11-01 in this zone: that day has 25 hours.
    expect(daysLeft(local(2026, 11, 2, 9), local(2026, 10, 31, 22))).toBe(2);
    // DST starts on 2026-03-08: that day has 23 hours.
    expect(daysLeft(local(2026, 3, 9, 1), local(2026, 3, 7, 23))).toBe(2);
  });

  it("clamps a past time to 0", () => {
    expect(daysLeft(local(2026, 12, 1), local(2026, 12, 5))).toBe(0);
  });
});

describe("expiresAt and isOlder", () => {
  it("deletes 30 days after the check", () => {
    const checked = local(2026, 11, 1, 12);
    expect(expiresAt(checked) - checked).toBe(EXPIRE_AFTER_DAYS * DAY_MS);
  });

  it("is older in the last 15 calendar days", () => {
    const checked = local(2026, 11, 1, 12);
    // The delete is on 2026-12-01 (DST ended on 2026-11-01).
    expect(isOlder(checked, local(2026, 11, 15, 23))).toBe(false);
    expect(isOlder(checked, local(2026, 11, 16, 0, 1))).toBe(true);
  });
});

describe("expiryVariant", () => {
  it("changes at 1 and 7 days", () => {
    expect(expiryVariant(0)).toBe("danger");
    expect(expiryVariant(1)).toBe("danger");
    expect(expiryVariant(2)).toBe("warning");
    expect(expiryVariant(7)).toBe("warning");
    expect(expiryVariant(8)).toBe("brand");
  });
});
