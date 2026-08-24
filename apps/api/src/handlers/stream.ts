// ddrive — Range-proxy streaming endpoint (Phase 3 groundwork, MVP granularity)
//
// Streams video/audio straight from the storage provider through the API,
// decrypting only the chunk(s) covering the requested byte range — no
// Service Worker, no client-side crypto, no full-file buffering anywhere.
//
// Granularity note: chunks are decrypted whole (not sub-chunk byte-sliced
// from the provider), so a Range request only ever pulls the ~8 MiB chunk(s)
// that cover it, then slices the exact bytes in memory before responding.
// This is coarser than the old client-side SW engine (which prefetched at
// chunk granularity too, for what it's worth) but still nowhere near "decrypt
// the whole file to seek" — see docs/hermes/concept.md section 4.2.

import { db } from "@ddv4/database";
import { verifySessionToken } from "../middleware/auth.js";
import { readBlobBytes } from "./blob.js";
import { decryptServerSide, plaintextSizeFor } from "../storage/server-crypto.js";
import type { PlacementRow } from "../storage/provider.js";

interface ChunkMeta {
  index: number;
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId: string | null;
  discordChannelId: string | null;
  webhookId: string | null;
  ciphertextSizeBytes: number;
  plaintextSizeBytes: number;
  placements: PlacementRow[];
}

function parseChunkIndex(blobId: string): number | null {
  const m = /:chunk:(\d+)$/.exec(blobId);
  return m ? Number(m[1]) : null;
}

async function getOrderedChunks(fileId: string, ownerUserId: string): Promise<ChunkMeta[]> {
  const rows = await db.blobTransport.findMany({
    where: { ownerUserId, blobId: { startsWith: `${fileId}:chunk:` } },
    include: { placements: true },
  });

  const chunks: ChunkMeta[] = [];
  for (const row of rows) {
    const index = parseChunkIndex(row.blobId);
    if (index === null) continue;
    chunks.push({
      index,
      blobId: row.blobId,
      ownerUserId: row.ownerUserId,
      storageKind: row.storageKind,
      storagePath: row.storagePath,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      webhookId: row.webhookId,
      ciphertextSizeBytes: Number(row.sizeBytes),
      plaintextSizeBytes: plaintextSizeFor(Number(row.sizeBytes)),
      placements: row.placements as unknown as PlacementRow[],
    });
  }

  chunks.sort((a, b) => a.index - b.index);
  return chunks;
}

function extractAuthToken(req: Request, url: URL): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // <video>/<audio> tags can't set custom headers, so also accept ?token=.
  // Trade-off noted in docs/hermes/plan.md Phase 3 — acceptable for the
  // dev-preview MVP, revisit before treating this as production-hardened.
  const queryToken = url.searchParams.get("token");
  return queryToken || null;
}

export async function handleStreamRequest(req: Request, params: { fileId: string }): Promise<Response> {
  const url = new URL(req.url);
  const token = extractAuthToken(req, url);

  let userId: string;
  let anonSessionId: string | null = null;
  if (token) {
    try {
      const payload = await verifySessionToken(token);
      userId = payload.userId;
    } catch {
      return Response.json({ error: "Invalid or expired token" }, { status: 401 });
    }
  } else {
    // Anonymous path (Phase 8): media elements can't set custom headers, so
    // accept the anon session as ?anon= (or the standard X-Anon-Session-Id).
    // Scope strictly to files uploaded by that browser session.
    anonSessionId = url.searchParams.get("anon") ?? req.headers.get("x-anon-session-id");
    if (!anonSessionId) return Response.json({ error: "Authentication required" }, { status: 401 });
    userId = ""; // resolved from the anon-scoped file row below
  }

  const file = await db.file.findFirst({
    where: anonSessionId
      ? { id: params.fileId, isAnonymous: true, anonSessionId, deletedAt: null, status: "READY" }
      : { id: params.fileId, ownerUserId: userId, deletedAt: null, status: "READY" },
  });
  if (!file) return Response.json({ error: "File not found" }, { status: 404 });

  const chunks = await getOrderedChunks(params.fileId, file.ownerUserId);
  if (chunks.length === 0) return Response.json({ error: "File has no chunks" }, { status: 404 });

  const totalSize = chunks.reduce((sum, c) => sum + c.plaintextSizeBytes, 0);
  const mimeType = file.mimeType || "application/octet-stream";

  // Cumulative plaintext offset where each chunk starts.
  const offsets: number[] = [];
  let running = 0;
  for (const c of chunks) {
    offsets.push(running);
    running += c.plaintextSizeBytes;
  }

  const rangeHeader = req.headers.get("range");

  let start = 0;
  let end = totalSize - 1;
  let status = 200;

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) return new Response("Invalid range", { status: 416 });
    start = parseInt(match[1]!, 10);
    end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
    end = Math.min(end, totalSize - 1);
    if (start >= totalSize || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${totalSize}` } });
    }
    status = 206;
  }

  // Find the chunk range covering [start, end].
  const firstIdx = offsets.findIndex((offset, i) => start < offset + chunks[i]!.plaintextSizeBytes);
  let lastIdx = firstIdx;
  for (let i = firstIdx; i < chunks.length; i++) {
    lastIdx = i;
    if (offsets[i]! + chunks[i]!.plaintextSizeBytes > end) break;
  }

  const pieces: Uint8Array[] = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const chunk = chunks[i]!;
    const encrypted = await readBlobBytes({
      blobId: chunk.blobId,
      ownerUserId: chunk.ownerUserId,
      storageKind: chunk.storageKind,
      storagePath: chunk.storagePath,
      discordMessageId: chunk.discordMessageId,
      discordChannelId: chunk.discordChannelId,
      webhookId: chunk.webhookId,
      sizeBytes: BigInt(chunk.ciphertextSizeBytes),
      contentHash: null,
      healthStatus: null,
      healthCheckedAt: null,
      createdAt: new Date(),
      placements: chunk.placements,
    });
    const plaintext = decryptServerSide(encrypted);

    const chunkStart = offsets[i]!;
    const chunkEnd = chunkStart + chunk.plaintextSizeBytes - 1;
    const sliceStart = Math.max(0, start - chunkStart);
    const sliceEnd = Math.min(chunk.plaintextSizeBytes - 1, end - chunkStart);
    if (sliceStart <= sliceEnd) {
      pieces.push(plaintext.subarray(sliceStart, sliceEnd + 1));
    }
    void chunkEnd; // kept for readability of the math above
  }

  const totalBytes = pieces.reduce((sum, p) => sum + p.byteLength, 0);
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of pieces) {
    body.set(p, offset);
    offset += p.byteLength;
  }

  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Content-Length": totalBytes.toString(),
  };
  if (status === 206) {
    headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
  }

  return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
    status,
    headers,
  });
}
