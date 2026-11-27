"use client";

import { useMutedLists } from "@/client/mutes";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";
import { KeepScreenOnSwitch } from "../../_components/keep-screen-on";

/**
 * "Keep screen on" and the notifications of this list, below the list name
 * (#82). Settings has the same switches. On a narrow screen they wrap.
 */
export function ListSwitches({ listId }: { listId: string }) {
  const { muted, setListMuted } = useMutedLists();

  async function toggle(control: HTMLInputElement) {
    try {
      await setListMuted(listId, !control.checked);
    } catch {
      // The switch changed itself. Put it back.
      control.checked = !control.checked;
      showToast({ message: copy.list.notificationsFailed });
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
      <KeepScreenOnSwitch />
      {muted && (
        <wa-switch
          checked={!muted.has(listId)}
          onChange={(event) =>
            void toggle(event.currentTarget as unknown as HTMLInputElement)
          }
        >
          {copy.list.notifications}
        </wa-switch>
      )}
    </div>
  );
}
