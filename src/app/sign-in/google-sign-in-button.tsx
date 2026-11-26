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
    <button
      type="button"
      onClick={signIn}
      disabled={pending}
      className="mt-10 min-h-12 w-full rounded-lg bg-accent px-5 text-base font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-70"
    >
      {pending ? "Opening Google…" : "Sign in with Google"}
    </button>
  );
}
