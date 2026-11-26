import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline – Shopping Lists" };

// The service worker shows this page offline for a page that this device
// never opened online. It is static and needs no session.
export default function OfflinePage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">You’re offline</h1>
      <p className="text-lg text-ink-muted">
        This page isn’t saved on this device yet. Your lists are, and changes
        you make sync when you’re back online.
      </p>
      {/* A full page load, so the service worker can serve the saved page. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/"
        className="mt-4 grid min-h-12 place-items-center rounded-xl bg-accent px-5 font-semibold text-accent-ink"
      >
        Go to your lists
      </a>
    </main>
  );
}
