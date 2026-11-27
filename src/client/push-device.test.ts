import { describe, expect, it } from "vitest";
import type { SubscriptionInfo } from "@/shared/push";
import { pushStatus, type PushFacts } from "./push-device";

const HERE = "https://fcm.googleapis.com/fcm/send/here";

function device(enabled: boolean, endpoint = HERE): SubscriptionInfo {
  return {
    id: "d1",
    endpoint,
    deviceLabel: "Mac · Chrome",
    enabled,
    createdAt: 0,
    lastSuccessAt: null,
    notDelivering: false,
  };
}

const ready: PushFacts = {
  publicKey: "key",
  support: "ok",
  permission: "granted",
  endpoint: HERE,
  devices: [device(true)],
};

describe("pushStatus", () => {
  it("is unavailable without server keys", () => {
    expect(pushStatus({ ...ready, publicKey: null })).toBe("unavailable");
  });

  it("is unavailable on iPhone Safari outside the Home Screen app", () => {
    expect(pushStatus({ ...ready, support: "needs-install" })).toBe(
      "unavailable",
    );
  });

  it("is unavailable in an unsupported browser", () => {
    expect(pushStatus({ ...ready, support: "unsupported" })).toBe(
      "unavailable",
    );
  });

  it("is unavailable when notifications are blocked", () => {
    expect(pushStatus({ ...ready, permission: "denied" })).toBe("unavailable");
  });

  it("is loading until the facts are known", () => {
    expect(pushStatus({ ...ready, support: "loading" })).toBe("loading");
    expect(pushStatus({ ...ready, publicKey: undefined })).toBe("loading");
    expect(pushStatus({ ...ready, devices: undefined })).toBe("loading");
    expect(pushStatus({ ...ready, endpoint: undefined })).toBe("loading");
  });

  it("is off with no subscription in this browser", () => {
    expect(pushStatus({ ...ready, endpoint: null })).toBe("off");
  });

  it("is off with a subscription that has no row", () => {
    expect(
      pushStatus({ ...ready, devices: [device(true, "https://other")] }),
    ).toBe("off");
  });

  it("is off when the row of this device is off", () => {
    expect(pushStatus({ ...ready, devices: [device(false)] })).toBe("off");
  });

  it("is on when the row of this device is on", () => {
    expect(pushStatus(ready)).toBe("on");
  });
});
