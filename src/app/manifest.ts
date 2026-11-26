import type { MetadataRoute } from "next";

// The web app manifest. Make the icons again from assets/icon.svg if it
// changes: rsvg-convert -w <size> -h <size> assets/icon.svg -o <file>. The
// artwork stays in the maskable safe zone, thus one source makes both kinds.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Shopping Lists",
    description: "Shared shopping lists that work offline.",
    short_name: "Lists",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // A manifest has one color only. The layout sets a theme color for each
    // scheme. These are the light canvas colors (globals.css).
    background_color: "#f2f5f0",
    theme_color: "#f2f5f0",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
