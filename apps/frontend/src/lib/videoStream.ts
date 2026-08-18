// ddrive — Video/audio streaming
//
// Post-E2EE-removal: no Service Worker, no client-side decrypt. The API's
// /api/stream/:fileId route (apps/api/src/handlers/stream.ts) proxies bytes
// straight from the storage provider with real HTTP Range support, so a
// plain <video>/<audio> element pointed at the URL just works — the browser
// handles seeking natively. See docs/hermes/concept.md section 4.2.

import { useAuthStore } from "../stores/auth.js";

export interface StreamFileInfo {
  fileId: string;
  fileName: string;
  mimeType: string;
}

/**
 * Returns a URL a <video>/<audio> element can use directly. The auth token
 * is passed as a query param because media elements can't set custom
 * headers — acceptable for the dev-preview MVP (see plan.md Phase 3 notes).
 */
export function getStreamUrl(fileId: string): string {
  const token = useAuthStore.getState().token ?? "";
  return `/api/stream/${fileId}?token=${encodeURIComponent(token)}`;
}
