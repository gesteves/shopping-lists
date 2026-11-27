"use client";

import { Serwist } from "@serwist/window";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { showToast } from "@/client/toasts";
import { copy } from "@/copy";

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
 * the app shows. Shows a toast with Reload when a new version takes
 * control. It stays until the user closes it.
 */
export function ServiceWorker() {
  const pathname = usePathname();

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || serwist) return;
    serwist = new Serwist("/sw.js", { scope: "/" });
    serwist.addEventListener("controlling", (event) => {
      if (event.isUpdate) {
        showToast({
          message: copy.newVersion.message,
          icon: "arrow-rotate-right",
          variant: "brand",
          duration: 0,
          action: { label: copy.common.reload, run: () => location.reload() },
        });
      }
      // The first page load came before the worker: save it now.
      cacheCurrentPage();
    });
    void serwist.register();
  }, []);

  // A client-side navigation loads no HTML. Save the HTML of the new page.
  useEffect(() => {
    if (navigator.serviceWorker?.controller) cacheCurrentPage();
  }, [pathname]);

  return null;
}
