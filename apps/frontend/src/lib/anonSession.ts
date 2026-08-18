// ddrive — Anonymous session id (Phase 6)
//
// Convenience-only grouping key so a browser can list "files I uploaded"
// without an account. NEVER used as an auth mechanism — the share link
// itself (id + token) is the only thing that actually grants access. See
// docs/hermes/concept.md section 4.7.

const STORAGE_KEY = "ddv4-anon-session-id";

export function getOrCreateAnonSessionId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage unavailable (private mode, etc.) — generate ephemeral id
    return crypto.randomUUID();
  }
}
