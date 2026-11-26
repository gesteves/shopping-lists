import type { MetadataRoute } from "next";

// A minimal manifest, so the app can go on the Home Screen. #10 adds the rest.
// Make the icons again from assets/icon.svg if it changes.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Shopping Lists",
    short_name: "Lists",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fafaf9",
    theme_color: "#14532d",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
