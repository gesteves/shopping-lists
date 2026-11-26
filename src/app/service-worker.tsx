"use client";

import { Serwist } from "@serwist/window";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

let serwist: Serwist | undefined;

/** Save the current page in the service worker cache, for offline use. */
function cacheCurrentPage() {
  if (!navigator.onLine) return;
  void serwist?.messageSW({
    type: "CACHE_URLS",
    payload: { urlsToCache: [location.href] },
  });
}

/**
 * Registers the service worker (production only) and saves each page that
 * the app shows. Shows a prompt to reload when a new version takes control.
 */
export function ServiceWorker() {
  const pathname = usePathname();
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || serwist) return;
    serwist = new Serwist("/sw.js", { scope: "/" });
    serwist.addEventListener("controlling", (event) => {
      if (event.isUpdate) setUpdated(true);
      // The first page load came before the worker: save it now.
      cacheCurrentPage();
    });
    void serwist.register();
  }, []);

  // A client-side navigation loads no HTML. Save the HTML of the new page.
  useEffect(() => {
    if (navigator.serviceWorker?.controller) cacheCurrentPage();
  }, [pathname]);

  if (!updated) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-lg"
    >
      <p className="flex-1">A new version of the app is ready.</p>
      <button
        type="button"
        onClick={() => location.reload()}
        className="min-h-11 rounded-lg bg-accent px-4 font-semibold text-accent-ink"
      >
        Reload
      </button>
    </div>
  );
}
