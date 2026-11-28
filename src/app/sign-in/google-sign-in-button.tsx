"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { authClient } from "@/lib/auth-client";

export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);

  async function signIn() {
    setPending(true);
    // A full-page redirect, not a popup. Popups fail in an installed iOS PWA.
    const { error } = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/sign-in",
    });
    if (error) setPending(false);
  }

  return (
    <wa-button
      suppressHydrationWarning
      variant="brand"
      size="l"
      onClick={signIn}
      loading={pending}
      className="mt-10 w-full"
    >
      <wa-icon
        suppressHydrationWarning
        slot="start"
        family="brands"
        name="google"
      ></wa-icon>
      {pending ? copy.signIn.opening : copy.signIn.button}
    </wa-button>
  );
}
