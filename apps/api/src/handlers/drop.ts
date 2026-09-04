// ddrive — Server-rendered /drop entry page.
//
// The actual upload UI is the SPA at /app/drop. This page is a thin SEO
// entry: it tells crawlers and humans what /drop is, then links into the
// SPA. Indexed separately so "ddrive drop" / "drop a file" searches land
// here, with a clear CTA into the real product.

import { escapeHtml, jsonLd, renderMetaTags } from "./seo-helpers.js";

const META: Parameters<typeof renderMetaTags>[1] = {
  title: "Drop a file — ddrive",
  description:
    "Drop a file with ddrive. Free temporary file sharing with no sign-up. " +
    "Get a shareable link in seconds.",
  path: "/drop",
  ogType: "website",
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": "https://ddrive.cikowice.pl/drop/#webpage",
  url: "https://ddrive.cikowice.pl/drop",
  name: META.title,
  description: META.description,
  isPartOf: { "@id": "https://ddrive.cikowice.pl/#website" },
  inLanguage: "en-US",
};

const BODY_HTML = `
<div id="root">
  <header class="topbar">
    <a class="brand" href="/">ddrive</a>
    <nav>
      <a href="/drop">Drop a file</a>
      <a href="/login">Sign in</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Drop a file</h1>
      <p class="lede">Pick a file, get a shareable link. The upload UI lives in the ddrive app &mdash; the button below opens it.</p>
      <p class="cta">
        <a class="btn primary" href="/app/drop">Open the drop zone</a>
        <a class="btn" href="/">Back to home</a>
      </p>
    </section>
    <section id="what">
      <h2>What /drop does</h2>
      <ul class="features">
        <li>Splits any file into chunks and uploads them in parallel.</li>
        <li>Encrypts each chunk before it leaves the browser.</li>
        <li>Returns a single shareable link with an optional expiry.</li>
        <li>No account required for a single share &mdash; anonymous drops live 30 days by default.</li>
      </ul>
    </section>
    <section id="also">
      <h2>Already have an account?</h2>
      <p><a href="/login">Sign in</a> to keep, organize and stream your files.</p>
    </section>
    <section id="disclaimer" class="disclaimer">
      <p><strong>Proof of concept.</strong> ddrive is provided as-is, with no uptime or reliability guarantees. Files may be deleted or corrupted at any time. Don't use ddrive as the only copy of important data.</p>
    </section>
  </main>
  <footer>
    <p>&copy; ddrive. <a href="/">Home</a> &middot; <a href="/login">Sign in</a> &middot; <a href="/sitemap.xml">Sitemap</a> &middot; <a href="/robots.txt">robots.txt</a></p>
  </footer>
</div>
`;

const STYLE = `
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
         margin: 0; background: #0b0d10; color: #e8eaed; line-height: 1.55; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
            padding: 16px 24px; border-bottom: 1px solid #1c1f24; }
  .brand { font-weight: 700; font-size: 20px; color: #e8eaed; text-decoration: none; }
  .topbar nav a { color: #9aa0a6; text-decoration: none; margin-left: 20px; font-size: 14px; }
  .topbar nav a:hover { color: #e8eaed; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 24px 0 12px; }
  h2 { font-size: 20px; margin: 40px 0 12px; }
  .lede { font-size: 17px; color: #c2c5cb; margin: 0 0 24px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 10px 18px; border-radius: 8px;
         text-decoration: none; font-size: 14px; font-weight: 500;
         border: 1px solid #3c4043; color: #e8eaed; background: transparent; }
  .btn.primary { background: #6366f1; border-color: #6366f1; color: white; }
  .btn:hover { filter: brightness(1.1); }
  a { color: #8ab4ff; }
  .features { padding-left: 0; list-style: none; }
  .features li { padding: 8px 0; border-bottom: 1px solid #1c1f24; }
  .features li:last-child { border: 0; }
  .disclaimer { margin-top: 32px; padding: 12px 16px; border: 1px solid #4a2c2c; border-radius: 8px; background: #1a0f0f; }
  .disclaimer p { color: #d6b6b6; font-size: 13px; margin: 0; }
  .disclaimer strong { color: #f5a3a3; }
  footer { border-top: 1px solid #1c1f24; padding: 24px; text-align: center;
           color: #9aa0a6; font-size: 13px; }
  footer a { color: #9aa0a6; }
  @media (max-width: 600px) { h1 { font-size: 24px; } .topbar { padding: 12px 16px; } }
</style>
`;

export async function handleDropPage(req: Request): Promise<Response> {
  const title = META.title;
  const metaTags = renderMetaTags(req, META);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${metaTags}
${jsonLd(JSON_LD)}
${STYLE}
</head>
<body>
${BODY_HTML}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
