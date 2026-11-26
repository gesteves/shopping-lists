import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shopping Lists",
  description: "Shared shopping lists.",
  // Open as a standalone app from the iOS Home Screen.
  appleWebApp: { capable: true, title: "Lists", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#14532d" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
