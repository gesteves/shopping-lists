"use client";

import { useCallback, useEffect, useState } from "react";
import { base64UrlToBytes, deviceLabel, isIos } from "@/client/device";
import { useLists } from "@/client/hooks";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
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
      showToast({ message: copy.settings.enableFailed });
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
            ? copy.settings.testSent(sent)
            : failed > 0
              ? copy.settings.testUndelivered
              : copy.settings.testNoDevices,
      });
    } catch {
      showToast({ message: copy.settings.testFailed });
    }
  }

  const subscribedHere =
    endpoint !== null && devices?.some((d) => d.endpoint === endpoint);

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="this-device" className="flex flex-col gap-3">
        <h2 id="this-device" className="text-xl font-semibold">
          {copy.settings.thisDevice}
        </h2>
        {!publicKey ? (
          <p className="text-ink-muted">{copy.settings.pushNotConfigured}</p>
        ) : support === "needs-install" ? (
          <p className="text-ink-muted">{copy.settings.pushNeedsInstall}</p>
        ) : support === "unsupported" ? (
          <p className="text-ink-muted">{copy.settings.pushUnsupported}</p>
        ) : permission === "denied" ? (
          <p className="text-ink-muted">{copy.settings.pushBlocked}</p>
        ) : subscribedHere ? (
          <p className="text-ink-muted">{copy.settings.pushOn}</p>
        ) : support === "ok" ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-ink-muted">{copy.settings.pushOffer}</p>
            <wa-button variant="brand" size="l" onClick={enable} loading={busy}>
              <wa-icon slot="start" name="bell"></wa-icon>
              {copy.settings.enablePush}
            </wa-button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="devices" className="flex flex-col gap-3">
        <h2 id="devices" className="text-xl font-semibold">
          {copy.settings.devices}
        </h2>
        {devices === undefined ? null : devices.length === 0 ? (
          <p className="text-ink-muted">{copy.settings.noDevices}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => {
              const label = device.deviceLabel ?? copy.settings.unnamedDevice;
              return (
                <li
                  key={device.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3"
                >
                  <span className="flex-1 font-medium">
                    {label}
                    {device.endpoint === endpoint && (
                      <span className="ml-2 text-sm font-normal text-ink-muted">
                        {copy.settings.currentDevice}
                      </span>
                    )}
                  </span>
                  <wa-switch
                    checked={device.enabled}
                    onChange={() => void toggle(device)}
                  >
                    <span className="sr-only">
                      {copy.settings.deviceSwitch(label)}
                    </span>
                    <span aria-hidden="true" className="text-sm text-ink-muted">
                      {device.enabled ? copy.settings.on : copy.settings.off}
                    </span>
                  </wa-switch>
                  <wa-button
                    variant="danger"
                    appearance="plain"
                    onClick={() => void remove(device)}
                  >
                    {copy.settings.remove}
                    <span className="sr-only"> {label}</span>
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
            {copy.settings.sendTest}
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
        {copy.settings.lists}
      </h2>
      <p className="text-ink-muted">{copy.settings.listsHint}</p>
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
                <span className="sr-only">
                  {copy.settings.listSwitch(list.name)}
                </span>
              </wa-switch>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
