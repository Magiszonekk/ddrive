// ddrive — Server-side thumbnail generation (Phase 2 of the non-E2EE fork)
//
// Runs after commitManifest, off the request path. Decodes the file (the
// server can — it holds the decryption key, see server-crypto.ts), produces
// a small lowres preview via ffmpeg, and stores it through the normal blob
// pipeline as `${fileId}:thumb` — same providers, same encryption.
//
// Skips generation when the original is already small/lowres (per
// docs/hermes/concept.md section 4.3) — in that case the original doubles
// as its own preview, so there's no point duplicating it.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { db } from "@ddv4/database";
import { config } from "@ddv4/config";
import { getPoolFor, getPrimaryPool } from "./provider.js";
import { getConfiguredReplicaKinds } from "./replica-pools.js";
import { encryptServerSide } from "./server-crypto.js";
import { readBlobBytes } from "../handlers/blob.js";
import { decryptServerSide } from "./server-crypto.js";
import type { PlacementRow } from "./provider.js";

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isVideo(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

/** Runs ffmpeg with args, returns stdout/stderr on failure for diagnostics. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function runFfprobeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      const seconds = parseFloat(stdout.trim());
      resolve(Number.isFinite(seconds) ? seconds : 0);
    });
  });
}

async function generateImageThumbnail(inputPath: string, outputPath: string): Promise<void> {
  const dim = config.thumbnail.maxDimension;
  await runFfmpeg([
    "-y", "-i", inputPath,
    "-vf", `scale='min(${dim},iw)':'min(${dim},ih)':force_original_aspect_ratio=decrease`,
    "-frames:v", "1",
    "-q:v", "5",
    outputPath,
  ]);
}

async function generateVideoThumbnail(inputPath: string, outputPath: string): Promise<void> {
  const dim = config.thumbnail.maxDimension;
  let seekSeconds = 1;
  try {
    const duration = await runFfprobeDuration(inputPath);
    if (duration > 0) seekSeconds = Math.max(0.5, duration * config.thumbnail.videoFrameAtFraction);
  } catch {
    // best-effort — fall back to the 1s default
  }

  await runFfmpeg([
    "-y", "-ss", String(seekSeconds), "-i", inputPath,
    "-vf", `scale='min(${dim},iw)':'min(${dim},ih)':force_original_aspect_ratio=decrease`,
    "-frames:v", "1",
    "-q:v", "5",
    outputPath,
  ]);
}

/** Reassembles a file's plaintext chunks in order, decrypting each on the way. */
async function reassembleFile(fileId: string, ownerUserId: string, chunkCount: number): Promise<Uint8Array> {
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
    if (!row) throw new Error(`Missing chunk ${i} for file ${fileId}`);
    const encrypted = await readBlobBytes({
      blobId: row.blobId,
      ownerUserId: row.ownerUserId,
      storageKind: row.storageKind,
      storagePath: row.storagePath,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      webhookId: row.webhookId,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      healthStatus: row.healthStatus,
      healthCheckedAt: row.healthCheckedAt,
      createdAt: row.createdAt,
      placements: row.placements as unknown as PlacementRow[],
    });
    buffers.push(decryptServerSide(encrypted));
  }

  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  return out;
}

/** Stores a thumbnail blob through the normal provider pipeline. Returns its blobId. */
async function storeThumbnailBlob(ownerUserId: string, fileId: string, plaintext: Uint8Array): Promise<string> {
  const blobId = `${fileId}:thumb`;
  const content = encryptServerSide(plaintext);
  const pool = getPrimaryPool();

  const written = await pool.put(ownerUserId, blobId, content, {});

  await db.blobTransport.upsert({
    where: { blobId },
    create: {
      blobId,
      ownerUserId,
      storageKind: pool.kind,
      storagePath: written.storagePath,
      discordMessageId: written.messageId,
      discordChannelId: written.locationId,
      webhookId: written.senderId,
      sizeBytes: BigInt(content.byteLength),
      contentHash: null,
    },
    update: {
      storageKind: pool.kind,
      storagePath: written.storagePath,
      discordMessageId: written.messageId,
      discordChannelId: written.locationId,
      webhookId: written.senderId,
      sizeBytes: BigInt(content.byteLength),
    },
  });
  await db.blobPlacement.upsert({
    where: { blobId_provider_poolRole: { blobId, provider: pool.kind, poolRole: "PRIMARY" } },
    create: {
      blobId,
      provider: pool.kind,
      poolRole: "PRIMARY",
      status: "ACTIVE",
      storagePath: written.storagePath,
      messageId: written.messageId,
      locationId: written.locationId,
      senderId: written.senderId,
      activatedAt: new Date(),
    },
    update: {
      status: "ACTIVE",
      storagePath: written.storagePath,
      messageId: written.messageId,
      locationId: written.locationId,
      senderId: written.senderId,
      activatedAt: new Date(),
    },
  });

  const replicaKinds = getConfiguredReplicaKinds();
  for (const kind of replicaKinds) {
    try {
      const replicaPool = getPoolFor(kind, "REPLICA");
      const replicaWritten = await replicaPool.put(ownerUserId, blobId, content, {});
      await db.blobPlacement.upsert({
        where: { blobId_provider_poolRole: { blobId, provider: kind, poolRole: "REPLICA" } },
        create: {
          blobId, provider: kind, poolRole: "REPLICA", status: "ACTIVE",
          storagePath: replicaWritten.storagePath, messageId: replicaWritten.messageId,
          locationId: replicaWritten.locationId, senderId: replicaWritten.senderId,
          activatedAt: new Date(),
        },
        update: {
          status: "ACTIVE", storagePath: replicaWritten.storagePath, messageId: replicaWritten.messageId,
          locationId: replicaWritten.locationId, senderId: replicaWritten.senderId, activatedAt: new Date(),
        },
      });
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), scope: "thumbnail", type: "replica_write_failed",
        blobId, kind, error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return blobId;
}

/**
 * Generates and stores a thumbnail for a file, if eligible. Fire-and-forget
 * caller pattern — failures are logged, never thrown into the upload path.
 */
export async function generateThumbnailForFile(fileId: string): Promise<void> {
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.status !== "READY") return;

  const mimeType = file.mimeType ?? "";
  const isImg = isImage(mimeType);
  const isVid = isVideo(mimeType);
  if (!isImg && !isVid) return; // nothing to thumbnail

  const sizeBytes = Number(file.totalBytes);
  const threshold = isImg ? config.thumbnail.skipImageBelowBytes : config.thumbnail.skipVideoBelowBytes;
  if (sizeBytes > 0 && sizeBytes <= threshold) {
    // Original is already small/lowres — it doubles as its own preview.
    return;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "ddrive-thumb-"));
  try {
    const ext = isImg ? "img" : "mp4";
    const inputPath = path.join(tmpDir, `input.${ext}`);
    const outputPath = path.join(tmpDir, "thumb.jpg");

    const plaintext = await reassembleFile(fileId, file.ownerUserId, file.chunkCount);
    await writeFile(inputPath, plaintext);

    if (isImg) {
      await generateImageThumbnail(inputPath, outputPath);
    } else {
      await generateVideoThumbnail(inputPath, outputPath);
    }

    const thumbBytes = await readFile(outputPath);
    const blobId = await storeThumbnailBlob(file.ownerUserId, fileId, new Uint8Array(thumbBytes));

    await db.file.update({ where: { id: fileId }, data: { thumbnailBlobId: blobId } });

    console.log(JSON.stringify({
      ts: new Date().toISOString(), scope: "thumbnail", type: "generated",
      fileId, mimeType, sizeBytes, thumbBytes: thumbBytes.byteLength,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), scope: "thumbnail", type: "generation_failed",
      fileId, mimeType, error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
