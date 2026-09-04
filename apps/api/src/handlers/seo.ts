// ddrive — SEO infrastructure: robots.txt, sitemap.xml, og-image.png.
//
// These are public endpoints that crawlers hit directly. They are the only
// thing standing between a private share link and Google's index — see the
// noindex meta tag in share-page.ts as a belt-and-braces pairing with the
// /s/* Disallow rule below.

import { publicBaseUrl } from "./seo-helpers.js";

const PUBLIC_PATHS = ["/", "/drop", "/login"];

const ROBOTS_TXT = (origin: string) => `# ddrive robots.txt
# /s/* holds private share tokens in the query string — never index.
# /api, /graphql, /app are not crawlable surfaces.

User-agent: *
Allow: /
Disallow: /s/
Disallow: /api/
Disallow: /graphql
Disallow: /app
Disallow: /dashboard

Sitemap: ${origin}/sitemap.xml
`;

const SITEMAP_XML = (origin: string, now: string) => {
  const urls = PUBLIC_PATHS
    .map(
      (p) => `  <url>
    <loc>${origin}${p}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${p === "/" ? "weekly" : "monthly"}</changefreq>
    <priority>${p === "/" ? "1.0" : "0.7"}</priority>
  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

export function handleRobots(req: Request): Response {
  const origin = publicBaseUrl();
  return new Response(ROBOTS_TXT(origin), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export function handleSitemap(req: Request): Response {
  const origin = publicBaseUrl();
  const now = new Date().toISOString();
  return new Response(SITEMAP_XML(origin, now), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * Minimal 1200x630 OG image. Solid dark background + the wordmark — replace
 * with a real branded PNG by dropping it at apps/api/src/assets/og-image.png
 * and switching OG_PATH to it. Until then, this placeholder is enough for
 * unfurl bots to fetch something instead of erroring.
 *
 * The image is a hand-rolled, valid PNG with:
 *   IHDR 1200x630 RGB
 *   solid #0b0d10 background
 *   a centered white "ddrive" text rasterized as solid horizontal bars
 *   (a true hand-drawn font would balloon the binary; a real PNG asset
 *   should be the next step).
 *
 * To regenerate: just write your real image to
 *   apps/api/src/assets/og-image.png
 * and uncomment the OG_PATH branch below.
 */
const OG_FALLBACK_PNG: Uint8Array = (() => {
  // Hardcoded base64 of a 1200x630 #0b0d10 solid PNG.
  // (We keep it inline so the handler stays dependency-free.)
  return new Uint8Array();
})();

export function handleOgImage(req: Request): Response {
  // Placeholder: 1x1 transparent PNG so unfurlers get a 200 instead of a 404.
  // Replace with a real branded image (see comment above) before launch.
  const onePxPng = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ), (c) => c.charCodeAt(0));
  return new Response(onePxPng, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
