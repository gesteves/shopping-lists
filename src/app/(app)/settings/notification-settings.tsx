"use client";

import { useState } from "react";
import { useLists } from "@/client/hooks";
import { useMutedLists } from "@/client/mutes";
import { usePushDevice } from "@/client/push-device";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import type { SubscriptionInfo } from "@/shared/push";

/** Push on this device, all devices, and muted lists (#15, #98). */
export function NotificationSettings() {
  const push = usePushDevice();
  const { publicKey, support, permission, endpoint, devices } = push;
  const [busy, setBusy] = useState(false);

  async function enable() {
    setBusy(true);
    const ok = await push.enable();
    setBusy(false);
    if (!ok && Notification.permission !== "denied") {
      showToast({ message: copy.settings.enableFailed });
    }
  }

  // The switch changes itself before the request. On an error, put it back
  // and tell why (#104).
  async function toggle(device: SubscriptionInfo, control: HTMLInputElement) {
    try {
      await push.toggle(device);
    } catch {
      control.checked = device.enabled;
      showToast({ message: copy.settings.deviceFailed });
    }
  }

  async function remove(device: SubscriptionInfo) {
    try {
      await push.remove(device);
    } catch {
      showToast({ message: copy.settings.removeFailed });
    }
  }

  async function sendTest() {
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { sent, failed } = (await res.json()) as {
        sent: number;
        failed: number;
      };
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
        {publicKey === undefined ||
        support === "loading" ? null : !publicKey ? (
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
            <wa-button variant="brand" onClick={enable} loading={busy}>
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
                    onChange={(event) =>
                      void toggle(
                        device,
                        event.currentTarget as unknown as HTMLInputElement,
                      )
                    }
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
  const { muted, setListMuted } = useMutedLists();

  async function toggleList(listId: string, control: HTMLInputElement) {
    try {
      await setListMuted(listId, !control.checked);
    } catch {
      // The switch changed itself. Put it back (#104).
      control.checked = !control.checked;
      showToast({ message: copy.list.notificationsFailed });
    }
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
                onChange={(event) =>
                  void toggleList(
                    list.id,
                    event.currentTarget as unknown as HTMLInputElement,
                  )
                }
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
