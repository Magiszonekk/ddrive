# ddrive — Concept (fork of DiscordDrive v4, non-E2EE)

Status: concept agreed with user 2026-08-18. Supersedes all prior `docs/hermes/*`
planning docs in this repo for anything E2EE-related — those documented the
OLD DiscordDrive v4 (E2EE) product that this repo was forked from. Historical
docs about the original E2EE product (secure-files v2, ARK/domain-key auth,
capability-token shares) are kept for reference but do not describe where
this fork is going.

## 1. What ddrive is

`ddrive` (github.com/Magiszonekk/ddrive) is a fork of DiscordDrive v4 — a
system that uses Discord (and/or Telegram) as bulk file storage: files are
chunked (~10MB), uploaded as message attachments through pluggable storage
providers, and served back through an API.

The fork's mission: turn the original "E2EE encrypted storage for nerds"
product into a consumer-friendly cloud drive — fast, with real previews,
search, streaming, and shareable links — for people who care about
convenience and simplicity, not managing encryption keys.

## 2. Why E2EE is dropped

True zero-knowledge E2EE means the server never sees plaintext or keys.
That directly blocks the features that make a modern file host feel good:

- **Thumbnails** — server must decode an image/video frame to build a
  lowres preview. Can't do that over ciphertext it can't read.
- **Filename search** — names must be server-readable/indexable.
- **Rich share-link embeds** — Open Graph previews and inline players
  require the server to understand content type and read bytes.
- **True HTTP Range streaming / seeking** — the E2EE version needs a
  Service Worker to fetch+decrypt chunks client-side; real Range-proxy
  streaming needs the server to decrypt on demand.

### The chosen tradeoff
Chunks stay AES-GCM encrypted at rest on Discord/Telegram (so a provider-side
leak, e.g. a compromised bot token or webhook, doesn't hand out raw files),
but **the decryption key lives server-side**, not with the user. This is
"encrypted in transit/at the storage provider", explicitly NOT E2EE. The
server can freely decrypt for thumbnails, streaming, search, previews.

## 3. Deployment topology

Mirrors the existing `discordrive-prod` pattern (same two physical machines,
separate deployment):

- **App/API server: OVH VPS** (146.59.126.32 = vps.cikowice.pl) — same class
  of setup as discordrive-prod: bare `node` process behind nginx (no docker
  required, though not precluded).
- **Database: cikowice_2222** (home server behind CGNAT, no public IP),
  reached from OVH over the existing WireGuard tunnel (OVH is a WG peer of
  cikowice's `wg0`, cikowice endpoint 146.59.126.32:51820) — exactly how
  discordrive-prod's Postgres already lives on cikowice at 10.8.0.4:5432.
- This is a **separate deployment** from discordrive-prod (different ports,
  different DB, different nginx vhost) — not a replacement. Both run
  side by side on the same two machines.

## 4. Product decisions

### 4.1 Encryption model
- Chunks: AES-GCM, encrypted before leaving the API on the way to
  Discord/Telegram.
- **v1: one global server-side key** for all chunks (env/secret-managed).
  Simpler than per-user keys; per-user keys (for selective revocation) is a
  possible later iteration, not required for v1.

### 4.2 Streaming
- Real HTTP Range-request streaming: the API proxies bytes directly from the
  provider, decrypting only the requested chunk(s) or a small read-ahead
  buffer on demand.
- Explicitly NOT the old model (Service Worker fetching+decrypting the whole
  manifest client-side, buffering full chunks in browser memory). No full
  file materializes in RAM or on disk anywhere in the pipeline just to seek.

### 4.3 Thumbnails / previews
- Generated at upload time, stored as **a separate small blob on ddrive
  itself** (through the same Discord/Telegram pipeline), sized to comfortably
  fit in a single ~10MB chunk (ideally much smaller).
- **Skip thumbnail generation when the original is already small/lowres** —
  in that case the original IS the preview; no point duplicating it.

### 4.4 Search
- v1 scope: filename search only.
- AI/content tagging is explicitly deferred — it's primarily used by
  `discordrive-gallery` (the companion Android app, currently built against
  the E2EE product) and wiring that integration is 2nd/3rd-priority work,
  not part of v1.

### 4.5 Sharing & embeds
- Share = random unguessable token in a URL. Server validates the token
  against the DB and serves directly. No client-side crypto — unlike the old
  capability-token + wrapped-key model.
- **Both** embed mechanisms are wanted:
  1. **Open Graph meta tags** on the share page, so pasting the link into
     Discord/Twitter/iMessage/etc. auto-renders an external preview/player.
  2. **A real inline player/viewer** on ddrive's own share page — video
     plays inline, images render inline — for humans opening the link
     directly.
- **Abuse/report flow**: a "report this share link" mechanism so illegal
  content can be located and taken down. Needed for legal/ToS cover once
  the product is public-facing.

### 4.6 Multi-user
- Real product direction: multiple accounts, many different users — not a
  personal/family drive. Public-facing product intent from the start.

### 4.7 Anonymous (no-login) sharing
Decided model (a deliberate combination, not one single mechanism):

1. **The link is the credential.** An anonymous upload immediately returns a
   random share token; that link IS the default access method — not an
   optional layer bolted onto an owned file.
2. **Anonymous session UUID in localStorage** — convenience only, not a
   security boundary. Lets the UI show "recent uploads from this browser".
   Copy/pasteable to another browser to see the same list, but this proves
   nothing about ownership.
3. **Claim flow** — a logged-in user opening an anonymous share link can
   claim it onto their account: removes the TTL, transfers ownership. A
   natural anonymous → registered bridge.
4. **Mandatory TTL** on all anonymous uploads (~1–2 months, exact number
   TBD at build time), swept/purged the same way the existing
   `purgeExpiredTrash` pattern already works in the codebase.
5. **Rejected as identity mechanisms** (explicitly ruled out): IP-as-identity
   (breaks under CGNAT — notably cikowice_2222 itself sits behind CGNAT —
   and under mobile carrier NAT) and hardware fingerprinting (invasive,
   fragile across browsers/devices).

### 4.8 Limits
- Logged-in users: no size or count limits (default unlimited).
- Anonymous users: TTL only for v1. No per-IP size/rate limiting yet — if
  abuse becomes a real problem, add a per-IP monthly quota later (small,
  deliberately deferred change, not v1 scope).

### 4.9 Naming
- Currently just "ddrive" (informal fork of "discordrive"). Open to a real
  name later; nothing formal chosen.

## 5. Current known-broken state (found during codebase analysis, 2026-08-18)

The fork sits mid-refactor. Backend has already dropped E2EE; frontend has
not caught up, and the app is **not currently usable past login**:

- Backend (`schema.prisma`, `resolvers/auth.ts`, `resolvers/files.ts`) is
  already on the new non-E2EE contract: plain `passwordHash` (sha256
  placeholder — `TODO(phase2): replace with argon2id`), plain `name`/
  `mimeType` fields, no more `wrappedFEK`/`UserCrypto`/`DomainKey`/
  `EncryptedState` models.
- Frontend is stuck on the old crypto flow:
  - `App.tsx`'s `ProtectedRoute` still gates on `if (!ark) return <Unlock />`,
    but `login()` no longer returns an `ark` at all — **every login loops
    forever on the Unlock screen.** This is a hard blocker.
  - `apps/frontend/src/lib/crypto.ts` still has the full old apparatus
    (`registerCrypto`, `wrapKey`/`unwrapKey`, `prepareFileUpload` with
    `wrappedFEK`, `prepareShareLink` with capability tokens) — dead code
    against the new backend contract.
  - `apps/frontend/src/lib/upload.ts` still encrypts client-side and sends
    `wrappedFEK` to `initUpload` — mismatched with the new resolver.
  - `npm run typecheck` currently **fails**: `Dashboard.tsx` passes
    `wrappedFEK` into `OwnerPreviewOptions`, which the partially-updated
    (uncommitted) `preview.ts` no longer accepts.
- Uncommitted in-flight changes exist on top of the E2EE-strip commit:
  `FolderBreadcrumb.tsx`, `NewFolderModal.tsx`, `RenameFolderModal.tsx`,
  `preview.ts`.

See `docs/hermes/plan.md` for the phased plan to get from here to the full
vision above.
