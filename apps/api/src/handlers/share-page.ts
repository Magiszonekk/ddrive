// ddrive — Server-rendered share page (Phase 5)
//
// GET /s/:shareId?t=<token> returns real HTML with Open Graph meta tags so
// Discord/Twitter/iMessage unfurl a rich preview, AND a working inline
// player/downloader for humans who click through — no SPA load required,
// no client-side crypto. Token travels in the query string (not a URL
// fragment) because the server needs to see it to render OG tags; this is
// consistent with the non-E2EE trust model (the server already holds the
// decryption key). See docs/hermes/concept.md section 4.5.

import { db } from "@ddv4/database";
import { resolveShareForPage } from "../resolvers/sharing.js";
import { readBlobBytes } from "./blob.js";
import { decryptServerSide } from "../storage/server-crypto.js";
import { serverConfig } from "@ddv4/config/server";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isImage(mimeType: string) { return mimeType.startsWith("image/"); }
function isVideo(mimeType: string) { return mimeType.startsWith("video/"); }
function isAudio(mimeType: string) { return mimeType.startsWith("audio/"); }

export async function handleSharePage(req: Request, params: { shareId: string }): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  // Behind nginx (TLS terminates there), req.url's protocol is always
  // http:// — trust X-Forwarded-Proto for the public-facing origin so OG
  // tags and generated links use https:// in production.
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const origin = `${forwardedProto ?? url.protocol.replace(":", "")}://${url.host}`;

  if (!token) {
    return new Response(renderErrorPage("Missing share token"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const share = await resolveShareForPage(params.shareId, token);
  if (!share) {
    return new Response(renderErrorPage("This share link is invalid, expired, or was revoked."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Folder shares render a simple shared-folder page (no OG media/preview —
  // the interactive browse + ZIP download lives in the SPA at /s/:shareId).
  if (share.shareType === "FOLDER") {
    const name = "Shared folder";
    const pageUrl = `${origin}/s/${share.shareId}?t=${encodeURIComponent(token)}`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)} — ddrive</title>
<meta property="og:title" content="${escapeHtml(name)}" />
<meta property="og:site_name" content="ddrive" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px 16px; background: #0b0d10; color: #e8eaed; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
  .card { max-width: 480px; width: 100%; text-align: center; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  .meta { color: #9aa0a6; font-size: 13px; margin-bottom: 20px; }
  .btn { display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; }
</style>
</head>
<body>
  <div class="card">
    <h1>📁 ${escapeHtml(name)}</h1>
    <p class="meta">A shared folder on ddrive</p>
    <a class="btn" href="${escapeHtml(pageUrl)}">Open folder</a>
  </div>
</body>
</html>`;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const file = share.file;
  if (!file) {
    return new Response(renderErrorPage("This share link is invalid."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  const name = file.name ?? "shared-file";
  const mimeType = file.mimeType ?? "application/octet-stream";
  const pageUrl = `${origin}/s/${share.shareId}?t=${encodeURIComponent(token)}`;
  const mediaUrl = `${origin}/s/${share.shareId}/media?t=${encodeURIComponent(token)}`;
  const downloadUrl = `${origin}/s/${share.shareId}/download?t=${encodeURIComponent(token)}`;

  const ogTags: string[] = [
    `<meta property="og:title" content="${escapeHtml(name)}" />`,
    `<meta property="og:site_name" content="ddrive" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];

  let bodyHtml: string;

  if (share.allowPreview && isImage(mimeType)) {
    ogTags.push(`<meta property="og:type" content="website" />`);
    ogTags.push(`<meta property="og:image" content="${escapeHtml(mediaUrl)}" />`);
    ogTags.push(`<meta name="twitter:image" content="${escapeHtml(mediaUrl)}" />`);
    bodyHtml = `<img src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(name)}" class="preview" />`;
  } else if (share.allowPreview && isVideo(mimeType)) {
    ogTags.push(`<meta property="og:type" content="video.other" />`);
    ogTags.push(`<meta property="og:video" content="${escapeHtml(mediaUrl)}" />`);
    ogTags.push(`<meta property="og:video:type" content="${escapeHtml(mimeType)}" />`);
    if (file.thumbnailBlobId) {
      const posterUrl = `${origin}/s/${share.shareId}/poster?t=${encodeURIComponent(token)}`;
      ogTags.push(`<meta property="og:image" content="${escapeHtml(posterUrl)}" />`);
    }
    bodyHtml = `<video src="${escapeHtml(mediaUrl)}" controls autoplay class="preview"></video>`;
  } else if (share.allowPreview && isAudio(mimeType)) {
    ogTags.push(`<meta property="og:type" content="music.song" />`);
    bodyHtml = `<audio src="${escapeHtml(mediaUrl)}" controls class="preview-audio"></audio>`;
  } else {
    ogTags.push(`<meta property="og:type" content="website" />`);
    ogTags.push(`<meta property="og:description" content="${escapeHtml(mimeType)} file shared via ddrive" />`);
    bodyHtml = `<div class="file-icon">📄</div>`;
  }

  const downloadButton = share.allowContent
    ? `<a class="btn" href="${escapeHtml(downloadUrl)}">Download</a>`
    : "";

  // Claim button (Phase 6): only meaningful for anonymous files, and only
  // clickable once JS detects a logged-in session token in localStorage —
  // ddv4-auth is the zustand-persist key written by stores/auth.ts.
  const claimSection = file.isAnonymous
    ? `<div id="claim-section" style="display:none;margin-top:12px;">
         <button class="btn btn-secondary" onclick="claimFile()">Save to my account</button>
       </div>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)} — ddrive</title>
${ogTags.join("\n")}
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px 16px; background: #0b0d10; color: #e8eaed; display: flex; flex-direction: column; align-items: center; min-height: 100vh; box-sizing: border-box; }
  .card { max-width: 720px; width: 100%; }
  h1 { font-size: 18px; font-weight: 600; word-break: break-word; margin: 0 0 4px; }
  .meta { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .preview { max-width: 100%; max-height: 70vh; border-radius: 12px; display: block; margin: 0 auto 16px; background: #16181c; }
  .preview-audio { width: 100%; margin-bottom: 16px; }
  .file-icon { font-size: 64px; text-align: center; margin-bottom: 16px; }
  .btn { display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; border: none; cursor: pointer; }
  .btn-secondary { background: transparent; border: 1px solid #3c4043; color: #e8eaed; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .report { color: #9aa0a6; font-size: 13px; text-decoration: underline; cursor: pointer; background: none; border: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(name)}</h1>
    <p class="meta">${escapeHtml(mimeType)}</p>
    ${bodyHtml}
    <div class="actions">
      ${downloadButton}
      <button class="report" onclick="reportShare()">Report this link</button>
    </div>
    ${claimSection}
  </div>
  <script>
    function reportShare() {
      const reason = prompt("Why are you reporting this link? (spam, copyright, illegal content, other)");
      if (!reason) return;
      fetch(${JSON.stringify(`${origin}/graphql`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "mutation($shareId:ID!,$reason:String!){ reportShare(shareId:$shareId,reason:$reason) }",
          variables: { shareId: ${JSON.stringify(share.shareId)}, reason },
        }),
      }).then(() => alert("Thanks — the link has been reported.")).catch(() => alert("Could not submit report."));
    }

    function getAuthToken() {
      try {
        const raw = localStorage.getItem("ddv4-auth");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed?.state?.token ?? null;
      } catch { return null; }
    }

    (function initClaimButton() {
      const section = document.getElementById("claim-section");
      if (!section) return;
      if (getAuthToken()) section.style.display = "block";
    })();

    function claimFile() {
      const authToken = getAuthToken();
      if (!authToken) { alert("Log in first, then come back to this link."); return; }
      fetch(${JSON.stringify(`${origin}/graphql`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + authToken },
        body: JSON.stringify({
          query: "mutation($shareId:ID!,$token:String!){ claimShare(shareId:$shareId,token:$token) }",
          variables: { shareId: ${JSON.stringify(share.shareId)}, token: ${JSON.stringify(token)} },
        }),
      }).then(r => r.json()).then(res => {
        if (res.errors) { alert(res.errors[0].message); return; }
        alert("Saved to your account — find it in your dashboard.");
        document.getElementById("claim-section").style.display = "none";
      }).catch(() => alert("Could not save this file."));
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function fetchAllChunksDecrypted(fileId: string, ownerUserId: string, chunkCount: number): Promise<Uint8Array> {
  const rows = await db.blobTransport.findMany({
    where: { ownerUserId, blobId: { startsWith: `${fileId}:chunk:` } },
    include: { placements: true },
  });
  const byIndex = new Map<number, typeof rows[number]>();
  for (const row of rows) {
    const m = /:chunk:(\d+)$/.exec(row.blobId);
    if (m) byIndex.set(Number(m[1]), row);
  }

  const buffers: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const row = byIndex.get(i);
    if (!row) throw new Error(`Missing chunk ${i}`);
    const encrypted = await readBlobBytes({
      blobId: row.blobId, ownerUserId: row.ownerUserId, storageKind: row.storageKind,
      storagePath: row.storagePath, discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId, webhookId: row.webhookId,
      sizeBytes: row.sizeBytes, contentHash: row.contentHash, healthStatus: row.healthStatus,
      healthCheckedAt: row.healthCheckedAt, createdAt: row.createdAt,
      placements: row.placements as never,
    });
    buffers.push(decryptServerSide(encrypted));
  }
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) { out.set(b, offset); offset += b.byteLength; }
  return out;
}

/** GET /s/:shareId/media — inline embed source (image/video/audio, no download disposition). */
export async function handleSharePageMedia(req: Request, params: { shareId: string }): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const share = await resolveShareForPage(params.shareId, token);
  if (!share || !share.allowPreview || share.shareType !== "FILE" || !share.file) return new Response("Not found", { status: 404 });

  try {
    const bytes = await fetchAllChunksDecrypted(share.fileId ?? "", share.file.ownerUserId, share.file.chunkCount);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: { "Content-Type": share.file.mimeType ?? "application/octet-stream", "Cache-Control": "private, max-age=300" },
    });
  } catch {
    return new Response("Failed to load media", { status: 500 });
  }
}

/** GET /s/:shareId/poster — thumbnail as og:image poster frame for videos. */
export async function handleSharePagePoster(req: Request, params: { shareId: string }): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const share = await resolveShareForPage(params.shareId, token);
  if (!share || !share.allowPreview || share.shareType !== "FILE" || !share.file?.thumbnailBlobId) return new Response("Not found", { status: 404 });

  const blob = await db.blobTransport.findUnique({ where: { blobId: share.file.thumbnailBlobId }, include: { placements: true } });
  if (!blob) return new Response("Not found", { status: 404 });

  try {
    const encrypted = await readBlobBytes(blob as never);
    const bytes = decryptServerSide(encrypted);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" },
    });
  } catch {
    return new Response("Failed to load poster", { status: 500 });
  }
}

/** GET /s/:shareId/download — full file with Content-Disposition: attachment. */
export async function handleSharePageDownload(req: Request, params: { shareId: string }): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const share = await resolveShareForPage(params.shareId, token);
  if (!share || !share.allowContent || share.shareType !== "FILE" || !share.file) return new Response("Not found", { status: 404 });

  try {
    const bytes = await fetchAllChunksDecrypted(share.fileId ?? "", share.file.ownerUserId, share.file.chunkCount);
    const fileName = share.file.name ?? "download";
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "Content-Type": share.file.mimeType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
      },
    });
  } catch {
    return new Response("Failed to load file", { status: 500 });
  }
}

function renderErrorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ddrive</title>
<style>body{font-family:-apple-system,sans-serif;background:#0b0d10;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px;}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
}
