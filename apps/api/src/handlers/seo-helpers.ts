// ddrive — Shared helpers for SSR SEO pages (landing, drop, share-page).
//
// Keep this dependency-free: no DB, no network. All consumers need is
// serverConfig.publicUrl + these primitives.

import { serverConfig } from "@ddv4/config/server";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Public-facing origin with no trailing slash. Trusts X-Forwarded-Proto when
 *  present (nginx terminates TLS in front of the API) so that
 *  canonical/OG URLs always come out https. */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path-only, e.g. "/" or "/drop" — no origin, no query. */
  path: string;
  /** og:type — "website", "article", "product" — defaults to "website". */
  ogType?: string;
  /** Absolute URL of the og:image. If omitted, fallback to /og-image.png. */
  ogImage?: string;
  /** Override the Twitter card variant. Default: "summary_large_image". */
  twitterCard?: "summary" | "summary_large_image";
  /** "noindex,nofollow" for share pages, "index,follow" (the default) for
   *  public marketing pages. */
  robots?: string;
}

/** Favicon <link> tags shared by every HTML surface (SSR pages + share page). */
export function faviconTags(origin: string): string {
  return [
    `<link rel="icon" type="image/svg+xml" href="${origin}/favicon.svg" />`,
    `<link rel="icon" type="image/png" sizes="32x32" href="${origin}/favicon-32.png" />`,
    `<link rel="shortcut icon" href="${origin}/favicon.ico" />`,
    `<link rel="apple-touch-icon" href="${origin}/apple-touch-icon.png" />`,
  ].join("\n");
}

export function renderMetaTags(req: Request, m: PageMeta): string {
  const origin = publicOrigin(req);
  const canonical = `${origin}${m.path}`;
  const ogImage = m.ogImage ?? `${origin}/og-image.png`;
  const robots = m.robots ?? "index,follow";
  const ogType = m.ogType ?? "website";

  const tags = [
    `<meta name="description" content="${escapeHtml(m.description)}" />`,
    `<meta name="robots" content="${escapeHtml(robots)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:title" content="${escapeHtml(m.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(m.description)}" />`,
    `<meta property="og:type" content="${escapeHtml(ogType)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}" />`,
    `<meta property="og:site_name" content="ddrive" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta name="twitter:card" content="${m.twitterCard ?? "summary_large_image"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(m.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(m.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`,
    `<meta name="theme-color" content="#0b0d10" />`,
  ];
  return faviconTags(origin) + "\n" + tags.join("\n");
}

/** Emit a JSON-LD <script> with safe JSON content. */
export function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

/** Pulls the public origin (no request context needed) for sitemap etc. */
export function publicBaseUrl(): string {
  return serverConfig.publicUrl.replace(/\/+$/, "");
}
