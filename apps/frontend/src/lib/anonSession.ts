// ddrive — Anonymous session id (Phase 6)
//
// Convenience-only grouping key so a browser can list "files I uploaded"
// without an account. NEVER used as an auth mechanism — the share link
// itself (id + token) is the only thing that actually grants access. See
// docs/hermes/concept.md section 4.7.
//
// Persisted in a first-party cookie (not just localStorage) because some
// browser contexts block localStorage access (private mode, sandboxed
// iframes, strict tracking prevention) — and the old code's catch block
// then minted a fresh UUID on every page load, orphaning previously
// created share links. A same-site cookie survives refresh in essentially
// all of those contexts, so "Existing share links" stays populated.

const COOKIE_NAME = "ddv4_anon_sid";
const LS_KEY = "ddv4-anon-session-id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

function readCookie(name: string): string | null {
  try {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}

export function getOrCreateAnonSessionId(): string {
  // 1) Already have a cookie? Reuse it.
  const cookieId = readCookie(COOKIE_NAME);
  if (cookieId) return cookieId;

  // 2) Migrate a legacy localStorage id (so shares created before this
  //    change are not orphaned), then persist it as a cookie.
  try {
    const lsId = localStorage.getItem(LS_KEY);
    if (lsId) {
      try {
        writeCookie(COOKIE_NAME, lsId);
      } catch {
        /* ignore */
      }
      return lsId;
    }
  } catch {
    /* ignore */
  }

  // 3) Fresh session — persist to both cookie and localStorage as backups.
  const fresh = crypto.randomUUID();
  try {
    writeCookie(COOKIE_NAME, fresh);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(LS_KEY, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}
