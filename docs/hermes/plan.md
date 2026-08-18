# ddrive — Implementation Plan

Status: draft plan, 2026-08-18. Read `docs/hermes/concept.md` first — this
plan implements the decisions documented there. This file replaces the
previous `plan.md` (which planned the original E2EE product this repo was
forked from; that content is obsolete for this fork's direction).

Ordering rationale: fix the hard blocker first (app is currently unusable),
then land features in the order that unblocks the next one — crypto model
before thumbnails (thumbnails need server-side decrypt), thumbnails before
grid UI (grid needs something to render), streaming before search doesn't
matter much (parallel-safe), sharing/anon last (needs everything else
stable to build on).

---

## Phase 0 — Unblock the app (fix the frontend/backend mismatch)

**Goal:** get the app usable end-to-end again on the already-non-E2EE
backend. Nothing new — just finish the refactor that was already started.

1. **Kill the `ark` gate.** In `apps/frontend/src/App.tsx`, `ProtectedRoute`
   currently does `if (!ark) return <Unlock />`. Since `login()` no longer
   returns an `ark`, this traps every user. Replace with a plain
   token-presence check (already half-there via `isTokenExpired`).
   Delete/repurpose `Unlock.tsx` (no more "unlock a session with a password
   separate from login" concept — logging in IS unlocking now).
2. **Gut `apps/frontend/src/stores/auth.ts`.** Drop `ark`/`filesKey` fields
   entirely; `PersistedUser` + `token` is enough.
3. **Gut `apps/frontend/src/lib/crypto.ts`.** Remove ARK/domain-key/FEK
   wrap-unwrap apparatus (`registerCrypto`, `loginCrypto`,
   `loginCryptoFromKey`, `prepareFileUpload`'s FEK wrapping,
   `prepareShareLink`'s capability tokens, `packWrappedKey`/`unpackWrappedKey`,
   folder-key helpers). Keep only what's still needed after Phase 0/1 land
   (likely: nothing — client-side crypto goes away entirely once chunk
   encryption moves server-side, see Phase 1).
4. **Fix `apps/frontend/src/lib/upload.ts`.** Stop calling
   `prepareFileUpload`/`encryptFileContentChunk` client-side; stop sending
   `wrappedFEK` in `INIT_UPLOAD`/`COMMIT_MANIFEST` GraphQL calls — match
   whatever `initUpload`/`commitManifest` resolvers actually accept now
   (plain `name`/`mimeType`/`totalBytes`).
5. **Fix `apps/frontend/src/lib/download.ts`, `preview.ts`,
   `videoStream.ts`, `apps/frontend/src/sw/stream-sw.ts`.** Same
   treatment — these all assume the client holds the FEK and does
   AES-GCM itself. Once Phase 1 moves encryption server-side, these either
   go away (server-side streaming needs no SW at all — see Phase 3) or get
   drastically simplified. `preview.ts` already has an uncommitted partial
   fix (in `git diff`) — finish and commit it.
6. **Commit uncommitted folder-modal changes** (`FolderBreadcrumb.tsx`,
   `NewFolderModal.tsx`, `RenameFolderModal.tsx`) once verified working, or
   fold them into this pass if they touch the same code paths.
7. **Verify:** `npm run typecheck` clean, `npm run build` clean, manual
   register → login → upload a file → see it in the file list, no crash.

Exit criteria: a fresh user can register, log in, upload, and see their
file — no Unlock screen, no crypto errors, typecheck green.

---

## Phase 1 — Server-side chunk encryption

**Goal:** chunks stay encrypted on Discord/Telegram, but the API holds the
key and does encrypt/decrypt itself, not the browser.

1. Add a server-side symmetric key (env var, e.g. `CHUNK_ENCRYPTION_KEY`,
   32 random bytes base64) — one global key for v1 (per concept.md §4.1).
2. Move chunk AES-GCM encrypt/decrypt from `apps/frontend/src/lib/crypto.ts`
   into the API's upload/download path (`apps/api/src/handlers/blob.ts` and
   wherever `initUpload`/`commitManifest` currently expect pre-encrypted
   ciphertext from the client). The API encrypts on the way to the storage
   provider, decrypts on the way back out.
3. Client now uploads **plaintext** chunks to the API over HTTPS (TLS is the
   only transport protection needed client→API; provider-at-rest encryption
   is now the API's job).
4. Keep the manifest concept (chunk index → blobId mapping) if useful for
   internal bookkeeping, but it no longer needs to be encrypted — store
   plain server-side (DB row(s) or a plain JSON blob), since there's no
   client-held FEK anymore.
5. Verify: upload/download roundtrip byte-identical (reuse/extend the
   existing `packages/processing/src/__tests__/crypto.test.ts` and the
   `npm run benchmark:e2e` script — port them off the client-crypto API).

Exit criteria: uploaded files are stored encrypted on Discord (verify by
fetching a raw attachment via Discord API and confirming it's not the
plaintext), and download returns byte-identical plaintext to a client that
never touches a key.

---

## Phase 2 — Thumbnails / previews

**Goal:** every eligible file gets a lowres preview generated server-side.

1. Pick a media-processing lib in the API's Node runtime (e.g. `sharp` for
   images; for video frame extraction, `ffmpeg` via a child process or a
   binding — needs to be present on the OVH box).
2. On `commitManifest` (or a follow-up async step), server decodes the
   file (now possible — server holds the key from Phase 1), generates a
   lowres thumbnail:
   - Images: resize to a small max-dimension (e.g. 480px), re-encode
     (webp/jpeg) for size.
   - Video: extract a representative frame (e.g. first keyframe or ~10%
     mark), same resize/encode as images.
   - **Skip generation when the original is already small/lowres** — reuse
     the original as its own preview (per concept.md §4.3). Define a
     concrete threshold (e.g. images <200KB or <480px on the long edge,
     video <2MB) — pick numbers when implementing, then document them here.
3. Store the thumbnail as its own small blob through the existing
   Discord/Telegram provider pipeline (`fileId:preview` naming convention,
   mirroring the existing `fileId:manifest`/`fileId:chunk:N` scheme). Add a
   `thumbnailBlobId` reference on `File` (schema already has this field —
   confirm it's wired through resolvers).
4. Frontend: `FileTable`/grid components fetch+render `thumbnailBlobId` via
   a simple authenticated GET (or public GET for share pages), not the old
   preview.ts decrypt pipeline.
5. Backfill: a script (mirroring `scripts/backfill-blob-placements.ts`) to
   generate thumbnails for files uploaded before this feature existed.

Exit criteria: uploading an image/video produces a visible, small,
fast-loading thumbnail in the file list within a few seconds of upload
completing.

---

## Phase 3 — Real Range-proxy streaming

**Goal:** video/audio playback with real seeking, no Service Worker, no
full-file client-side buffering.

1. New/updated API route (e.g. `GET /api/stream/:fileId`) that:
   - Reads the `Range` header from the request.
   - Maps the requested byte range to the corresponding chunk(s) via the
     file's manifest (chunk index arithmetic — `chunkSize` is fixed per
     file already).
   - Fetches only the needed chunk(s) from the provider (Discord/Telegram),
     decrypts server-side (Phase 1 key), and streams the requested byte
     range back with `206 Partial Content` + `Content-Range` + `Accept-Ranges`.
   - Small read-ahead buffer (a few chunks) for smooth playback without
     over-fetching.
2. Remove `apps/frontend/src/sw/stream-sw.ts` and
   `apps/frontend/src/lib/videoStream.ts`'s SW-message-protocol path
   entirely — point `<video>`/`<audio>` `src` directly at the new streaming
   endpoint URL (browsers natively handle Range requests against a normal
   URL).
3. Verify: seeking in a large video (skip to 80% mark) is near-instant and
   does not trigger a full-file download; confirm via network tab that only
   the requested byte ranges are fetched.

Exit criteria: video scrubbing feels like a normal `<video>` tag against a
static file server — because functionally, that's what this becomes.

---

## Phase 4 — Frontend UX: grid/list view + search

**Goal:** the actual "feels like a modern drive" UI layer.

1. Add a view-mode toggle (grid/tile vs. list) to `Dashboard.tsx`/
   `FileTable.tsx`, persisted per-user (localStorage is fine, or a user
   preference field if going through the DB).
2. Grid view: tile per file showing the lowres thumbnail (Phase 2),
   filename, maybe size/date on hover or in list view's columns.
3. Filename search: a search box wired to a GraphQL query filtering
   `File.name` (simple `contains`/ILIKE for v1 — Postgres full-text search
   or a trigram index if it needs to be fast at scale, decide at build
   time based on real file counts).
4. Keep both views' loading fast — this is the whole point of Phase 2's
   lowres thumbnails; don't regress it by lazy-loading full images by
   mistake.

Exit criteria: user can switch between grid/list, thumbnails load quickly
in both, typing in search narrows the file list by name.

---

## Phase 5 — Sharing with embeds

**Goal:** shareable links that look good when pasted anywhere, and play
inline when opened directly.

1. Simplify the `Share` model usage: token generation stays random +
   hashed in DB (schema already supports this, `tokenHash`) — drop any
   remaining client-crypto share prep in `crypto.ts`'s
   `prepareShareLink`/`deriveShareWrapKey` etc. (should already be gone
   after Phase 0).
2. Share page route (e.g. `/share/:token`) server-rendered or with
   server-injected `<meta property="og:...">` tags (image/video preview,
   title, description) so link unfurls work on Discord/Twitter/iMessage —
   requires either SSR for the share page or a dedicated non-SPA endpoint
   the API serves with proper OG tags before the SPA takes over for humans.
3. On-page player: reuse the Phase 3 streaming endpoint for video/audio,
   direct `<img>`/thumbnail-then-full for images, no auth required (share
   token is the auth).
4. Report/abuse endpoint: a simple "report this link" form on the share
   page → creates a flagged record an admin can review, with enough
   context (token, fileId, reporter note) to locate and take the file down.
   Exact admin workflow (dashboard vs. manual DB/CLI review) — decide at
   build time based on expected volume; start manual if volume is low.

Exit criteria: pasting a ddrive share link into Discord shows a rich
preview; opening it in a browser plays/shows the file inline; a report
button exists and creates a reviewable record.

---

## Phase 6 — Anonymous (no-login) uploads

**Goal:** implement the decided anon model from concept.md §4.7.

1. New anonymous upload path: no auth token required, API creates a `File`
   row with no `ownerUserId` (or a nullable owner) and a mandatory
   `expiresAt` (TTL — pick the concrete number, concept says ~1–2 months).
2. Response includes the share token directly — this IS the file's only
   access method (reuses Phase 5's Share model, or a lighter first-class
   "anonymous file" path if Share's assumptions don't fit).
3. Client: on anonymous upload, generate/store an anon session UUID in
   localStorage if one doesn't exist; tag the upload with it (a DB column,
   e.g. `anonSessionId`) purely so the UI can list "recent uploads from
   this browser" — never used for auth.
4. Claim flow: a logged-in user visiting an anonymous share link gets a
   "save to my account" button → mutation that sets `ownerUserId` and
   clears `expiresAt`.
5. TTL sweep: extend the existing `purgeExpiredTrash`-style sweep (already
   in `apps/api/src/resolvers/files.ts`) to also purge anonymous files past
   `expiresAt`, deleting provider blobs the same way trash purge already
   does.
6. No per-IP rate/size limiting in v1 (per concept.md §4.8) — just make
   sure the TTL sweep actually runs on a schedule (cron or in-process
   interval, mirroring however `purgeStaleUploads`/`purgeExpiredTrash` are
   currently triggered).

Exit criteria: an anonymous visitor can upload without registering, get a
working share link immediately, and the file disappears automatically
after the TTL; a logged-in user can claim it before that happens.

---

## Phase 7 — Deployment

**Status: DONE (2026-08-18).** Live at https://ddrive.cikowice.pl.

- DB: Postgres in Docker on cikowice_2222, project `ddrive-prod-db`,
  container `ddrive-prod-db-postgres-1`, port 5434 (bound 0.0.0.0, reachable
  from OVH over WireGuard at 10.8.0.4:5434). Separate from both the dev
  stack (`ddrive-dev-db`, port 5433) and discordrive-prod's DB.
- App: `/home/ubuntu/ddrive-prod` on OVH, git branch `main`, deployed via
  `git pull` (not a submodule/CI pipeline yet — manual `git pull && npm run
  build --workspace=@ddv4/frontend && systemctl restart` for updates).
- API: systemd unit `ddrive-prod-api.service`, port 3500, bare
  `node --env-file .env --import tsx src/index.ts` (same pattern as
  discordrive-api.service). Logs: `/var/log/ddrive-prod-api*.log`.
- Frontend: static Vite build served directly by nginx from
  `apps/frontend/dist` (not `vite preview`).
- nginx: `/etc/nginx/sites-available/ddrive-ssl` + `ddrive-http` (HTTP->HTTPS
  redirect + ACME challenge path). TLS via certbot, cert
  `ddrive.cikowice.pl`. Listens on port 4099 (not 443 directly — OVH routes
  443 through a `stream{}` SNI-preread block in the main nginx.conf that
  fans out to 4099 for all *.cikowice.pl https vhosts; this was the same
  non-obvious pattern discordrive-prod and pokemon.cikowice.pl already use).
- DNS: `ddrive.cikowice.pl` A record -> 146.59.126.32, created via the OVH
  API (mcp-ovh's credentials at `/home/ubuntu/Desktop/mcp-ovh/.env`).
- Storage: `STORAGE_PRIMARY_PROVIDERS=LOCAL` (disk on the OVH box) — no real
  Discord webhooks provisioned for this fork yet. Swap to DISCORD later by
  setting `STORAGE_PRIMARY_PROVIDERS=DISCORD` + `WEBHOOK_1..N` in
  `/home/ubuntu/ddrive-prod/.env` and restarting the service.
- Smoke test passed live (not just locally): register -> login -> upload
  plaintext chunk -> confirmed ciphertext unreadable on disk -> download
  byte-identical -> image upload -> thumbnail auto-generated via ffmpeg
  (1.5MB original -> 33.8KB/480px JPEG) -> share link -> OG-tagged
  server-rendered page (https:// URLs, fixed an http:// bug caught during
  this test) -> download via share -> anonymous upload -> share (caught and
  fixed a real bug: anon uploads called the auth-gated `createShare`,
  which can never succeed for an anonymous caller — added
  `createAnonymousShare`) -> claim to account -> file confirmed in the
  claiming account's file list.

Exit criteria: MET.


---

## Open questions to resolve during implementation (not blocking, but noted)

- Exact TTL number for anonymous uploads (concept says "~1-2 months, TBD").
- Exact "already lowres, skip thumbnail" size/dimension thresholds.
- Whether the share page needs real SSR or a lighter OG-tag-injection
  approach suffices (depends on chosen frontend framework's SSR story —
  current stack is a Vite SPA, which has no built-in SSR).
- Final product name (currently just "ddrive").
- Whether Postgres for this fork shares the existing cikowice Postgres
  instance or gets its own — depends on expected load once multi-user
  traffic is real.
