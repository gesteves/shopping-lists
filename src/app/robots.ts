import type { MetadataRoute } from "next";

// The app is private. Tell all crawlers to read no page (#83). The root
// layout also sets "noindex, nofollow" on each page.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
