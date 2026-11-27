import type { Metadata } from "next";
import { copy } from "@/copy";

export const metadata: Metadata = {
  title: copy.app.pageTitle(copy.offline.title),
};

// The service worker shows this page offline for a page that this device
// never opened online. It is static and needs no session.
export default function OfflinePage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">
        {copy.offline.heading}
      </h1>
      <p className="text-lg text-ink-muted">{copy.offline.body}</p>
      {/* A full page load (not a Next.js link), so the service worker can
          serve the saved page. */}
      <wa-button href="/" variant="brand" size="l" className="mt-4">
        {copy.offline.goToLists}
      </wa-button>
    </main>
  );
}
