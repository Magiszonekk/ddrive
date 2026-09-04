// ddrive — Server-rendered landing page (/) — temp file share focus.
//
// Targets search intent "temp file share", "temporary file sharing", "send
// large files free", "share files without signing up". Renders a real HTML
// document with full SEO tags so Google can index it, with FAQ schema and
// a CTA that links into the SPA at /app/drop for the actual upload UI.
//
// Other public surface (post-landing):
//   /drop  -> CTA card pointing at /app/drop (the actual drop UI)
//   /login -> CTA card pointing at /app/login (the actual login UI)
//   /robots.txt, /sitemap.xml, /og-image.png -> handled by seo.ts
//
// nginx routing: SSR endpoints here are proxied to the API; the SPA itself
// is mounted at /app/* on the same domain. See infra nginx config.

import { escapeHtml, jsonLd, renderMetaTags } from "./seo-helpers.js";

const META: Parameters<typeof renderMetaTags>[1] = {
  title: "Temp file share — ddrive",
  description:
    "Share files for free with ddrive. No sign-up, no account required. " +
    "Temporary file sharing that's fast and simple. Large files supported, " +
    "link expires automatically.",
  path: "/",
  ogType: "website",
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://ddrive.cikowice.pl/#website",
      url: "https://ddrive.cikowice.pl/",
      name: "ddrive",
      description: META.description,
      inLanguage: "en-US",
      publisher: { "@id": "https://ddrive.cikowice.pl/#org" },
    },
    {
      "@type": "Organization",
      "@id": "https://ddrive.cikowice.pl/#org",
      name: "ddrive",
      url: "https://ddrive.cikowice.pl/",
      logo: "https://ddrive.cikowice.pl/og-image.png",
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Is ddrive free?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. ddrive is a free temporary file sharing service. No account is required for a single share.",
          },
        },
        {
          "@type": "Question",
          name: "How long are files stored?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Anonymous drops are kept for 30 days by default, then permanently deleted. You can claim a drop into your account to keep it indefinitely.",
          },
        },
        {
          "@type": "Question",
          name: "What is the maximum file size?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "There is no hard limit per file. Files are split into chunks and uploaded in parallel, so even multi-gigabyte uploads work.",
          },
        },
        {
          "@type": "Question",
          name: "Do I need to create an account?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "No. /drop works without sign-up. Creating an account is only needed if you want to manage, organize or keep your files long-term.",
          },
        },
        {
          "@type": "Question",
          name: "Where are the files stored?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "On the ddrive instance you reach. Self-hosted instances keep files on infrastructure the operator controls.",
          },
        },
      ],
    },
  ],
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
      <h1>Temp file share &mdash; send files for free</h1>
      <p class="lede">Drop a file, get a link. No sign-up, no account, no size limit. ddrive is a free temporary file sharing service.</p>
      <p class="cta">
        <a class="btn primary" href="/app/drop">Open the drop zone</a>
        <a class="btn" href="/app/login">Sign in to your account</a>
      </p>
    </section>
    <section id="how">
      <h2>How it works</h2>
      <ol>
        <li>Click <strong>Open the drop zone</strong>.</li>
        <li>Pick a file &mdash; any size, any type.</li>
        <li>ddrive splits, encrypts and uploads the file in parallel.</li>
        <li>You get a shareable link that anyone with the link can open.</li>
      </ol>
    </section>
    <section id="faq">
      <h2>Frequently asked questions</h2>
      <dl class="faq">
        <dt>Is ddrive free?</dt>
        <dd>Yes. ddrive is a free temporary file sharing service. No account is required for a single share.</dd>
        <dt>How long are files stored?</dt>
        <dd>Anonymous drops are kept for 30 days by default, then permanently deleted. You can claim a drop into your account to keep it indefinitely.</dd>
        <dt>What is the maximum file size?</dt>
        <dd>There is no hard limit per file. Files are split into chunks and uploaded in parallel.</dd>
        <dt>Do I need to create an account?</dt>
        <dd>No. /drop works without sign-up. An account is only needed for long-term file management.</dd>
        <dt>Where are the files stored?</dt>
        <dd>On the ddrive instance you reach. Self-hosted instances keep files on infrastructure the operator controls.</dd>
      </dl>
    </section>
    <section id="also">
      <h2>Looking for permanent storage?</h2>
      <p>Create an account to keep, organize and stream your files. ddrive is a free cloud storage and Google Drive alternative &mdash; <a href="/login">sign in</a> to manage your files.</p>
    </section>
    <section id="compare">
      <h2>Anonymous drop vs. account</h2>
      <p class="lede-sm">Everything works without an account. Signing in unlocks storage that doesn't expire, organization, and API access.</p>
      <table class="compare">
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">No account</th>
            <th scope="col">With account</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Upload &amp; share files</th>
            <td class="yes">Yes</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Storage duration</th>
            <td>30 days, then deleted</td>
            <td class="yes">Kept until you delete it</td>
          </tr>
          <tr>
            <th scope="row">Folders &amp; organization</th>
            <td class="no">&mdash;</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Rename, move, bulk actions</th>
            <td class="no">&mdash;</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Streaming playback</th>
            <td class="yes">Yes</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Share links with expiry</th>
            <td class="yes">Yes</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Claim an anonymous drop later</th>
            <td class="yes">Yes, once signed in</td>
            <td class="yes">&mdash;</td>
          </tr>
          <tr>
            <th scope="row">API keys / programmatic access</th>
            <td class="no">&mdash;</td>
            <td class="yes">Yes</td>
          </tr>
          <tr>
            <th scope="row">Restore deleted files (trash)</th>
            <td class="no">&mdash;</td>
            <td class="yes">30-day trash window</td>
          </tr>
        </tbody>
      </table>
    </section>
    <section id="api">
      <h2>Use ddrive from the API</h2>
      <p>Every account can generate an API key and script uploads, downloads, and file management &mdash; no browser required. Keys are created under <a href="/app/settings">Settings &rarr; API keys</a> after signing in.</p>
      <ul class="features">
        <li>Send the key in an <code>x-api-key</code> header, prefixed <code>ddv4_</code>.</li>
        <li>Name each key, set an optional expiry, and revoke it any time.</li>
        <li>Works against both the GraphQL endpoint and the REST blob endpoints &mdash; same auth as the browser session.</li>
      </ul>
      <pre class="code"><code>curl https://ddrive.cikowice.pl/graphql \
  -H "x-api-key: ddv4_&lt;your-key&gt;" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ storageUsage { usedBytes fileCount } }"}'</code></pre>
    </section>
    <section id="disclaimer" class="disclaimer">
      <h2>Proof of concept &mdash; no warranty</h2>
      <p>ddrive is a personal proof-of-concept project provided as-is, with no uptime or reliability guarantees. Files stored through ddrive may be deleted, corrupted, or otherwise become inaccessible at any time &mdash; for any reason, including operator error, storage provider outages, or data loss.</p>
      <p>Do not use ddrive as the only copy of anything you care about. Always keep an independent backup of important files. By using ddrive you accept full responsibility for any data loss.</p>
    </section>
  </main>
  <footer>
    <p>&copy; ddrive. <a href="/drop">Drop a file</a> &middot; <a href="/login">Sign in</a> &middot; <a href="/sitemap.xml">Sitemap</a> &middot; <a href="/robots.txt">robots.txt</a></p>
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
  .faq dt { font-weight: 600; margin-top: 16px; }
  .faq dd { margin: 4px 0 0 0; color: #c2c5cb; }
  .lede-sm { font-size: 14px; color: #9aa0a6; margin: 0 0 16px; }
  table.compare { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  table.compare th, table.compare td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #1c1f24; }
  table.compare thead th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #9aa0a6; font-weight: 600; }
  table.compare tbody th { font-weight: 500; color: #e8eaed; white-space: nowrap; }
  table.compare td.yes { color: #7ee2a8; }
  table.compare td.no { color: #6b7178; }
  table.compare tbody tr:last-child th, table.compare tbody tr:last-child td { border-bottom: 0; }
  .features { padding-left: 0; list-style: none; margin: 12px 0 0; }
  .features li { padding: 8px 0; border-bottom: 1px solid #1c1f24; font-size: 14px; color: #c2c5cb; }
  .features li:last-child { border: 0; }
  code { font-family: "JetBrains Mono", ui-monospace, monospace; background: #16181c; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  pre.code { background: #0f1115; border: 1px solid #1c1f24; border-radius: 8px; padding: 16px; overflow-x: auto; margin-top: 12px; }
  pre.code code { background: none; padding: 0; font-size: 13px; line-height: 1.6; color: #c2c5cb; }
  .disclaimer { margin-top: 48px; padding: 16px; border: 1px solid #4a2c2c; border-radius: 8px; background: #1a0f0f; }
  .disclaimer h2 { margin-top: 0; color: #f5a3a3; }
  .disclaimer p { color: #d6b6b6; font-size: 14px; }
  ol { padding-left: 20px; }
  ol li { padding: 4px 0; }
  footer { border-top: 1px solid #1c1f24; padding: 24px; text-align: center;
           color: #9aa0a6; font-size: 13px; }
  footer a { color: #9aa0a6; }
  @media (max-width: 600px) {
    h1 { font-size: 24px; }
    .topbar { padding: 12px 16px; }
    table.compare { font-size: 12px; }
    table.compare th, table.compare td { padding: 8px 6px; }
  }
</style>
`;

export async function handleLanding(req: Request): Promise<Response> {
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
