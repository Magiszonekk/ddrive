// ddrive — Static favicon files served by the API for the SSR surface
// (/, /drop, /login, /s/*). The Vite-built SPA already ships these under
// dist/ (served by nginx at /app/... and copied from apps/frontend/public),
// but the SSR pages at the bare domain root need the exact same files
// reachable at the bare paths referenced by <link rel="icon"> tags
// (e.g. https://ddrive.cikowice.pl/favicon.svg) — nginx has no catch-all
// static root for those exact paths, so the API serves them directly from
// the same source files.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/src/handlers -> apps/frontend/public
const PUBLIC_DIR = resolve(__dirname, "../../../frontend/public");

interface FaviconFile {
  file: string;
  contentType: string;
}

const FAVICONS: Record<string, FaviconFile> = {
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
  "/favicon-32.png": { file: "favicon-32.png", contentType: "image/png" },
  "/favicon-192.png": { file: "favicon-192.png", contentType: "image/png" },
  "/favicon.ico": { file: "favicon.ico", contentType: "image/x-icon" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", contentType: "image/png" },
};

const cache = new Map<string, Buffer>();

export function isFaviconPath(pathname: string): boolean {
  return pathname in FAVICONS;
}

export function handleFavicon(pathname: string): Response {
  const entry = FAVICONS[pathname];
  if (!entry) {
    return new Response("Not found", { status: 404 });
  }
  let bytes = cache.get(entry.file);
  if (!bytes) {
    try {
      bytes = readFileSync(resolve(PUBLIC_DIR, entry.file));
      cache.set(entry.file, bytes);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": entry.contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
