// Push on this browser (#15, #98): the support, the permission, the
// subscription, and the devices of the user. Settings and the list page use
// the same hook.
import { useCallback, useEffect, useState } from "react";
import type { SubscriptionInfo } from "@/shared/push";
import { base64UrlToBytes, deviceLabel, isIos } from "./device";

export type Support =
  | "loading"
  | "unsupported"
  /** iPhone or iPad in Safari: push needs the Home Screen app. */
  | "needs-install"
  | "ok";

/**
 * Push on this device:
 *   - loading: the facts are not known yet.
 *   - unavailable: push cannot work here (no server keys, the Home Screen
 *     app is necessary, an unsupported browser, or notifications blocked).
 *   - on: this browser has a subscription, and its device row is on.
 *   - off: all other cases (no subscription, no row, or a row that is off).
 */
export type PushStatus = "loading" | "unavailable" | "off" | "on";

export interface PushFacts {
  /** The VAPID public key; null if the server has no keys. */
  publicKey: string | null | undefined;
  support: Support;
  permission: NotificationPermission | undefined;
  /** The endpoint of the subscription of this browser, or null. */
  endpoint: string | null | undefined;
  devices: SubscriptionInfo[] | undefined;
}

export function pushStatus(facts: PushFacts): PushStatus {
  const { publicKey, support, permission, endpoint, devices } = facts;
  if (publicKey === null) return "unavailable";
  if (support === "needs-install" || support === "unsupported") {
    return "unavailable";
  }
  if (permission === "denied") return "unavailable";
  if (
    support === "loading" ||
    publicKey === undefined ||
    devices === undefined ||
    endpoint === undefined
  ) {
    return "loading";
  }
  const row = endpoint && devices.find((d) => d.endpoint === endpoint);
  return row && row.enabled ? "on" : "off";
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** The facts about push on this browser, and the actions. */
export function usePushDevice() {
  const [support, setSupport] = useState<Support>("loading");
  const [permission, setPermission] = useState<NotificationPermission>();
  const [endpoint, setEndpoint] = useState<string | null>();
  const [devices, setDevices] = useState<SubscriptionInfo[]>();
  const [publicKey, setPublicKey] = useState<string | null>();

  const reload = useCallback(async () => {
    const body = (await api("/api/push/subscriptions")) as {
      subscriptions: SubscriptionInfo[];
      publicKey: string | null;
    };
    setDevices(body.subscriptions);
    setPublicKey(body.publicKey);
  }, []);

  useEffect(() => {
    const ua = navigator.userAgent;
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    const pushReady =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    // Effects run once at mount here: read the browser state, then show it.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (isIos(ua, navigator.maxTouchPoints) && !standalone) {
      setSupport("needs-install");
    } else {
      setSupport(pushReady ? "ok" : "unsupported");
    }
    if ("Notification" in window) setPermission(Notification.permission);
    if (!pushReady) setEndpoint(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (pushReady) {
      void navigator.serviceWorker
        .getRegistration()
        .then(async (reg) => {
          const sub = await reg?.pushManager.getSubscription();
          setEndpoint(sub?.endpoint ?? null);
        })
        .catch(() => setEndpoint(null));
    }
    void reload().catch(() => undefined);
  }, [reload]);

  /**
   * Ask for the permission, subscribe, and save this device. It also turns
   * on a device that is off. True on success. Call it from a tap: iOS asks
   * for the permission only then.
   */
  const enable = useCallback(async (): Promise<boolean> => {
    if (!publicKey) return false;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return false;
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(publicKey),
        }));
      await api("/api/push/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          ...sub.toJSON(),
          deviceLabel: deviceLabel(
            navigator.userAgent,
            navigator.maxTouchPoints,
          ),
        }),
      });
      setEndpoint(sub.endpoint);
      await reload();
      return true;
    } catch {
      return false;
    }
  }, [publicKey, reload]);

  /** Turn a device on or off. It throws on an error. */
  const toggle = useCallback(
    async (device: SubscriptionInfo) => {
      await api(`/api/push/subscriptions/${device.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !device.enabled }),
      });
      await reload();
    },
    [reload],
  );

  /** Remove a device. For this browser, also unsubscribe. It throws on an error. */
  const remove = useCallback(
    async (device: SubscriptionInfo) => {
      await api(`/api/push/subscriptions/${device.id}`, { method: "DELETE" });
      if (device.endpoint === endpoint) {
        const reg = await navigator.serviceWorker.getRegistration();
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        setEndpoint(null);
      }
      await reload();
    },
    [endpoint, reload],
  );

  const facts: PushFacts = {
    publicKey,
    support,
    permission,
    endpoint,
    devices,
  };
  return {
    ...facts,
    status: pushStatus(facts),
    thisDevice: endpoint
      ? (devices?.find((d) => d.endpoint === endpoint) ?? null)
      : null,
    enable,
    toggle,
    remove,
    reload,
  };
}
