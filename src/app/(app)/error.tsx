"use client";

import { useEffect } from "react";
import { reportError } from "@/client/report";
import { copy } from "@/copy";

// The error boundary of the signed-in pages (#147). It sends the error to
// the server log, and the person can try again. The local data is not
// changed: it is in IndexedDB.
export default function PageError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    const digest =
      error instanceof Error && "digest" in error
        ? String(error.digest)
        : undefined;
    reportError("render", error, { digest });
  }, [error]);

  return (
    <div className="grid flex-1 place-items-center py-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <p className="text-lg text-ink-muted">{copy.pageError.message}</p>
        <wa-button
          suppressHydrationWarning
          appearance="outlined"
          onClick={() => retry()}
        >
          {copy.pageError.retry}
        </wa-button>
      </div>
    </div>
  );
}
