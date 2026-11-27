"use client";

import { useState } from "react";
import { copy } from "@/copy";
import { authClient } from "@/lib/auth-client";

/**
 * Allow or deny. The auth client sends the signed query of the page, then
 * goes to the URL of the answer: the redirect URI of the client.
 */
export function ConsentButtons() {
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);

  async function answer(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setFailed(false);
    const { error } = await authClient.oauth2.consent({ accept });
    if (error) {
      setPending(null);
      setFailed(true);
    }
  }

  return (
    <>
      {failed && (
        <p
          role="alert"
          className="mt-6 border-l-4 border-danger py-1 pl-3 text-danger"
        >
          {copy.consent.failed}
        </p>
      )}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse">
        <wa-button
          variant="brand"
          size="l"
          className="sm:flex-1"
          loading={pending === "allow"}
          disabled={pending !== null}
          onClick={() => answer(true)}
        >
          {copy.consent.connect}
        </wa-button>
        <wa-button
          appearance="outlined"
          size="l"
          className="sm:flex-1"
          loading={pending === "deny"}
          disabled={pending !== null}
          onClick={() => answer(false)}
        >
          {copy.consent.dontConnect}
        </wa-button>
      </div>
    </>
  );
}
