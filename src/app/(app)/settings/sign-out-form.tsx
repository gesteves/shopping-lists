"use client";

import { clearDeviceForSignOut } from "@/client/sign-out";
import { copy } from "@/copy";
import { signOut } from "../../actions";

/**
 * Sign out. First the browser deletes the data, the pages, and the push
 * subscription of the user (#103), then the server ends the session.
 */
export function SignOutForm({ name }: { name: string }) {
  return (
    <form
      action={async () => {
        await clearDeviceForSignOut();
        await signOut();
      }}
      className="flex items-center gap-4"
    >
      <p className="flex-1 text-ink-muted">{copy.settings.signedInAs(name)}</p>
      <wa-button type="submit" appearance="outlined">
        {copy.settings.signOut}
      </wa-button>
    </form>
  );
}
