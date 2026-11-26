"use client";

import { useCallback, useEffect, useState } from "react";
import { base64UrlToBytes, deviceLabel, isIos } from "@/client/device";
import { useLists } from "@/client/hooks";
import { showToast } from "@/client/toasts";
import type { SubscriptionInfo } from "@/shared/push";

type Support =
  | "loading"
  | "unsupported"
  /** iPhone or iPad in Safari: push needs the Home Screen app. */
  | "needs-install"
  | "ok";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** Push on this device, all devices, and muted lists (#15). */
export function NotificationSettings({
  publicKey,
}: {
  publicKey: string | null;
}) {
  const [support, setSupport] = useState<Support>("loading");
  const [permission, setPermission] = useState<NotificationPermission>();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [devices, setDevices] = useState<SubscriptionInfo[]>();
  const [busy, setBusy] = useState(false);

  const loadDevices = useCallback(async () => {
    const { subscriptions } = await api("/api/push/subscriptions");
    setDevices(subscriptions);
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
    /* eslint-enable react-hooks/set-state-in-effect */
    if (pushReady) {
      void navigator.serviceWorker.getRegistration().then(async (reg) => {
        const sub = await reg?.pushManager.getSubscription();
        setEndpoint(sub?.endpoint ?? null);
      });
    }
    void loadDevices().catch(() => undefined);
  }, [loadDevices]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    try {
      // The permission prompt must come from this tap.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
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
      await loadDevices();
    } catch {
      showToast({ message: "Notifications couldn’t be turned on. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(device: SubscriptionInfo) {
    await api(`/api/push/subscriptions/${device.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !device.enabled }),
    });
    await loadDevices();
  }

  async function remove(device: SubscriptionInfo) {
    await api(`/api/push/subscriptions/${device.id}`, { method: "DELETE" });
    if (device.endpoint === endpoint) {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      setEndpoint(null);
    }
    await loadDevices();
  }

  async function sendTest() {
    try {
      const { sent, failed } = await api("/api/push/test", {
        method: "POST",
      });
      showToast({
        message:
          sent > 0
            ? `Sent a test notification to ${sent} ${sent === 1 ? "device" : "devices"}.`
            : failed > 0
              ? "The test notification didn’t reach your devices. Try again later."
              : "No device has notifications on.",
      });
    } catch {
      showToast({ message: "The test notification didn’t send." });
    }
  }

  const subscribedHere =
    endpoint !== null && devices?.some((d) => d.endpoint === endpoint);

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="this-device" className="flex flex-col gap-3">
        <h2 id="this-device" className="text-xl font-semibold">
          This device
        </h2>
        {!publicKey ? (
          <p className="text-ink-muted">
            Notifications aren’t set up on the server yet.
          </p>
        ) : support === "needs-install" ? (
          <p className="text-ink-muted">
            On iPhone and iPad, notifications work only in the app on your Home
            Screen. In Safari, tap Share, then Add to Home Screen. Open the app
            from there and come back to this page.
          </p>
        ) : support === "unsupported" ? (
          <p className="text-ink-muted">
            This browser can’t get notifications.
          </p>
        ) : permission === "denied" ? (
          <p className="text-ink-muted">
            Notifications are blocked for this app. Allow them in your browser
            or system settings, then come back.
          </p>
        ) : subscribedHere ? (
          <p className="text-ink-muted">
            This device gets a notification when the other person changes a
            list.
          </p>
        ) : support === "ok" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-ink-muted">
              Get a notification when the other person changes a list.
            </p>
            <wa-button variant="brand" size="l" onClick={enable} loading={busy}>
              <wa-icon slot="start" name="bell"></wa-icon>
              Enable notifications
            </wa-button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="devices" className="flex flex-col gap-3">
        <h2 id="devices" className="text-xl font-semibold">
          Your devices
        </h2>
        {devices === undefined ? null : devices.length === 0 ? (
          <p className="text-ink-muted">No device gets notifications yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => {
              const label = device.deviceLabel ?? "Unnamed device";
              return (
                <li
                  key={device.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
                >
                  <span className="flex-1 font-medium">
                    {label}
                    {device.endpoint === endpoint && (
                      <span className="ml-2 text-sm font-normal text-ink-muted">
                        This device
                      </span>
                    )}
                  </span>
                  <wa-switch
                    checked={device.enabled}
                    onChange={() => void toggle(device)}
                  >
                    <span className="sr-only">Notifications on {label}</span>
                    <span aria-hidden="true" className="text-sm text-ink-muted">
                      {device.enabled ? "On" : "Off"}
                    </span>
                  </wa-switch>
                  <wa-button
                    variant="danger"
                    appearance="plain"
                    onClick={() => void remove(device)}
                  >
                    Remove<span className="sr-only"> {label}</span>
                  </wa-button>
                </li>
              );
            })}
          </ul>
        )}
        {devices && devices.some((d) => d.enabled) && (
          <wa-button
            appearance="outlined"
            onClick={sendTest}
            className="self-start"
          >
            <wa-icon slot="start" name="bell"></wa-icon>
            Send a test notification
          </wa-button>
        )}
      </section>

      <MutedLists />
    </div>
  );
}

/** A switch for each list: notifications about it, or not. */
function MutedLists() {
  const lists = useLists();
  const [muted, setMuted] = useState<Set<string>>();

  useEffect(() => {
    void api("/api/push/mutes")
      .then(({ listIds }) => setMuted(new Set(listIds)))
      .catch(() => undefined);
  }, []);

  async function toggle(listId: string) {
    const next = !muted?.has(listId);
    await api("/api/push/mutes", {
      method: "PUT",
      body: JSON.stringify({ listId, muted: next }),
    });
    setMuted((m) => {
      const copy = new Set(m);
      if (next) copy.add(listId);
      else copy.delete(listId);
      return copy;
    });
  }

  if (!lists || !muted || lists.length === 0) return null;
  return (
    <section aria-labelledby="lists" className="flex flex-col gap-3">
      <h2 id="lists" className="text-xl font-semibold">
        Lists
      </h2>
      <p className="text-ink-muted">
        Turn off a list to get no notifications about it, on all your devices.
      </p>
      <ul className="flex flex-col gap-2">
        {lists.map((list) => (
          <li key={list.id}>
            <div className="flex min-h-12 items-center gap-3 rounded-xl border border-line bg-surface px-4">
              <span aria-hidden="true" className="flex-1 font-medium">
                {list.name}
              </span>
              <wa-switch
                checked={!muted.has(list.id)}
                onChange={() => void toggle(list.id)}
              >
                <span className="sr-only">Notifications about {list.name}</span>
              </wa-switch>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
