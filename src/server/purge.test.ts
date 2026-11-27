import { afterEach, describe, expect, it, vi } from "vitest";
import type { PurgeResult } from "./ops";
import {
  FIRST_PURGE_MS,
  PURGE_AFTER_DAYS,
  PURGE_EVERY_MS,
  runPurge,
  startPurger,
} from "./purge";

const RESULT: PurgeResult = {
  lists: 1,
  items: 2,
  processedOps: 3,
  activity: 4,
  purgedSeq: 5,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("purge schedule", () => {
  it("purges after 30 days, a few minutes after boot, then each day", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const purge = vi.fn(() => RESULT);
    startPurger(purge);
    // A second start does nothing.
    startPurger(purge);

    vi.advanceTimersByTime(FIRST_PURGE_MS - 1);
    expect(purge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(PURGE_AFTER_DAYS);
    expect(PURGE_AFTER_DAYS).toBe(30);

    vi.advanceTimersByTime(PURGE_EVERY_MS);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it("does not throw when a purge fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      runPurge(() => {
        throw new Error("disk full");
      }),
    ).toBeNull();
  });
});
