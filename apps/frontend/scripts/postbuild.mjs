// Post-build step: inject SEO meta tags into dist/index.html so that the
// Vite-built SPA also has the right <title>, description, canonical, OG
// and Twitter Card tags. This is a belt-and-braces layer — the API's SSR
// landing page (apps/api/src/handlers/landing.ts) is the primary SEO
// surface, but the dist build is what nginx serves in production, and
// we want both layers to be independently correct.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = resolve(__dirname, "../dist/index.html");

if (!existsSync(distPath)) {
  console.warn("[postbuild] dist/index.html not found, skipping SEO injection");
  process.exit(0);
}

let html = readFileSync(distPath, "utf8");
if (html.includes('name="description"')) {
  console.log("[postbuild] SEO tags already present, skipping");
  process.exit(0);
}

const tags = [
  '<title>Ddrive — Free cloud storage</title>',
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
  '<link rel="shortcut icon" href="/favicon.ico" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<meta name="description" content="ddrive is a free cloud storage and Google Drive alternative. Upload, store and stream files. Open source, self-hostable, no file size limits." />',
  '<link rel="canonical" href="https://ddrive.cikowice.pl/app/" />',
  '<meta property="og:title" content="Ddrive — Free cloud storage" />',
  '<meta property="og:description" content="ddrive is a free cloud storage and Google Drive alternative. Upload, store and stream files." />',
  '<meta property="og:type" content="website" />',
  '<meta property="og:url" content="https://ddrive.cikowice.pl/app/" />',
  '<meta property="og:image" content="https://ddrive.cikowice.pl/og-image.png" />',
  '<meta property="og:site_name" content="ddrive" />',
  '<meta name="twitter:card" content="summary_large_image" />',
  '<meta name="twitter:title" content="Ddrive — Free cloud storage" />',
  '<meta name="twitter:description" content="ddrive is a free cloud storage and Google Drive alternative. Upload, store and stream files." />',
  '<meta name="twitter:image" content="https://ddrive.cikowice.pl/og-image.png" />',
].join("\n");

if (!html.includes("<head>")) {
  console.warn("[postbuild] no <head> in dist/index.html, skipping");
  process.exit(0);
}

html = html.replace("<head>", `<head>\n${tags}\n`);
writeFileSync(distPath, html);
console.log("[postbuild] SEO tags injected into dist/index.html");
