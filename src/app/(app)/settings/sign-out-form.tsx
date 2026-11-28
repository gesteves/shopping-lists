"use client";

import { useState, useTransition } from "react";
import { clearDeviceForSignOut, syncBeforeSignOut } from "@/client/sign-out";
import { copy } from "@/copy";
import { signOut } from "../../actions";
import { ConfirmDialog } from "../_components/wa";

/** The browser part of sign-out (#103), then the server sign-out. */
async function finishSignOut() {
  await clearDeviceForSignOut();
  await signOut();
}

/**
 * Sign out. First the browser syncs. If changes did not sync, a dialog asks
 * first: the sign-out deletes them (#115). Then the browser deletes the data,
 * the pages, and the push subscription of the user (#103), and the server
 * ends the session.
 */
export function SignOutForm({ name }: { name: string }) {
  const [pending, setPending] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  return (
    <>
      <form
        action={async () => {
          const count = await syncBeforeSignOut();
          if (count > 0) setPending(count);
          else await finishSignOut();
        }}
        className="flex items-center gap-4"
      >
        <p className="flex-1 text-ink-muted">
          {copy.settings.signedInAs(name)}
        </p>
        <wa-button suppressHydrationWarning type="submit" appearance="outlined">
          {copy.settings.signOut}
        </wa-button>
      </form>
      <ConfirmDialog
        open={pending !== null}
        label={copy.settings.signOutPendingTitle}
        confirmLabel={copy.settings.signOut}
        danger
        onConfirm={() => {
          setPending(null);
          startTransition(finishSignOut);
        }}
        onClose={() => setPending(null)}
      >
        {copy.settings.signOutPendingBody(pending ?? 0)}
      </ConfirmDialog>
    </>
  );
}
