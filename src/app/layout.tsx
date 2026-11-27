import type { Metadata, Viewport } from "next";
import { copy, locale } from "@/copy";
import "./globals.css";
import { WebAwesome } from "./web-awesome";

export const metadata: Metadata = {
  title: copy.app.name,
  description: copy.app.description,
  // Open as a standalone app from the iOS Home Screen. "default" gives dark
  // status bar text on the light theme color and light text on the dark one.
  appleWebApp: {
    capable: true,
    title: copy.app.shortName,
    statusBarStyle: "default",
  },
};

// The server-rendered <head> must have the color scheme: never set it with
// JavaScript. The theme colors are the canvas colors in globals.css.
export const viewport: Viewport = {
  colorScheme: "light dark",
  // Use the full screen. The shell adds the safe-area insets.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f5f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a14" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <WebAwesome />
        {children}
      </body>
    </html>
  );
}
