import { describe, expect, it } from "vitest";
import { copy } from "@/copy";
import { syncIndicator } from "./sync-indicator";

describe("syncIndicator", () => {
  it("shows nothing when idle with no changes", () => {
    expect(syncIndicator("idle", 0)).toBeNull();
  });

  it("shows a still cloud for changes that wait, after a delay", () => {
    expect(syncIndicator("idle", 2)).toEqual({
      icon: "cloud-arrow-up",
      tone: "muted",
      animate: false,
      text: copy.sync.changesToSync(2),
      delayed: true,
    });
  });

  it("animates the cloud while a sync runs", () => {
    expect(syncIndicator("syncing", 1)).toMatchObject({
      icon: "cloud-arrow-up",
      animate: true,
      text: copy.sync.changesToSync(1),
      delayed: true,
    });
    expect(syncIndicator("syncing", 0)).toMatchObject({
      icon: "cloud-arrow-up",
      animate: true,
      text: null,
      delayed: true,
    });
  });

  it("shows offline at once", () => {
    expect(syncIndicator("offline", 0)).toEqual({
      icon: "cloud-slash",
      tone: "muted",
      animate: false,
      text: copy.sync.offline,
      delayed: false,
    });
    expect(syncIndicator("offline", 3)?.text).toBe(
      copy.sync.offlineWithChanges(3),
    );
  });

  it("shows an error in the danger tone", () => {
    expect(syncIndicator("error", 0)).toEqual({
      icon: "cloud-exclamation",
      tone: "danger",
      animate: false,
      text: copy.sync.error,
      delayed: false,
    });
    expect(syncIndicator("error", 2)?.text).toBe(copy.sync.errorWithChanges(2));
  });

  it("links to sign-in when the session ended", () => {
    expect(syncIndicator("unauthorized", 0)).toEqual({
      icon: "cloud-exclamation",
      tone: "danger",
      animate: false,
      text: copy.sync.signInAgain,
      href: "/sign-in",
      delayed: false,
    });
    expect(syncIndicator("unauthorized", 4)?.text).toBe(
      copy.sync.signInAgainWithChanges(4),
    );
  });
});
