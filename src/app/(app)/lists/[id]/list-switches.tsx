"use client";

import { useMutedLists } from "@/client/mutes";
import { usePushDevice } from "@/client/push-device";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { KeepScreenOnSwitch } from "../../_components/keep-screen-on";

/**
 * "Keep screen on" and the notifications of this list, below the list name
 * (#82). Settings has the same switches. On a narrow screen they wrap.
 *
 * The Notifications switch shows this device (#98): it is on only if this
 * device gets pushes and the list is not muted. It is always in the page,
 * thus it does not pop in (#136). It is disabled until the device and the
 * mutes are known, and where push cannot work. On turns on push here (one
 * tap) and unmutes the list. Off mutes the list on all devices. A private
 * list has no Notifications switch (#154).
 */
export function ListSwitches({
  listId,
  isPrivate,
}: {
  listId: string;
  /** A private list sends no push (#154): no Notifications switch. */
  isPrivate: boolean;
}) {
  const { muted, setListMuted } = useMutedLists();
  const push = usePushDevice();
  const ready =
    muted !== undefined &&
    push.status !== "loading" &&
    push.status !== "unavailable";

  async function turnOn(control: HTMLInputElement) {
    if (push.status !== "on" && !(await push.enable())) {
      control.checked = false;
      showToast({
        message:
          Notification.permission === "denied"
            ? copy.settings.pushBlocked
            : copy.settings.enableFailed,
      });
      return;
    }
    if (muted?.has(listId)) {
      try {
        await setListMuted(listId, false);
      } catch {
        control.checked = false;
        showToast({ message: copy.list.notificationsFailed });
      }
    }
  }

  async function turnOff(control: HTMLInputElement) {
    try {
      await setListMuted(listId, true);
      showToast({ message: copy.list.mutedEverywhere });
    } catch {
      control.checked = true;
      showToast({ message: copy.list.notificationsFailed });
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
      <KeepScreenOnSwitch />
      {!isPrivate && (
        <wa-switch
          disabled={!ready}
          checked={push.status === "on" && muted?.has(listId) === false}
          onChange={(event) => {
            const control = event.currentTarget as unknown as HTMLInputElement;
            void (control.checked ? turnOn(control) : turnOff(control));
          }}
        >
          {copy.list.notifications}
        </wa-switch>
      )}
    </div>
  );
}
