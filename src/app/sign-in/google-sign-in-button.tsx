"use client";

import { useState } from "react";
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
      variant="brand"
      size="l"
      onClick={signIn}
      loading={pending}
      className="mt-10 w-full"
    >
      <wa-icon slot="start" family="brands" name="google"></wa-icon>
      {pending ? "Opening Google…" : "Sign in with Google"}
    </wa-button>
  );
}
