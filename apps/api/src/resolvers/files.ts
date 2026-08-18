// ddrive v4 — File resolvers

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { db } from "@ddv4/database";
import { downloadChunk, getChunkUrl, parseWebhookUrls, WebhookRateLimiter, type WebhookInfo, downloadChunkBot, getChunkUrlBot, type BotInfo } from "@ddv4/discord-client";
import { getPoolFor, placementFromBlobRecord, placementFromRow, type PlacementRow, type PoolRole } from "../storage/provider.js";
import { getConfiguredReplicaKinds } from "../storage/replica-pools.js";
import { generateThumbnailForFile } from "../storage/thumbnail.js";
import { getSystemUserId } from "../middleware/auth.js";
import { config } from "@ddv4/config";
import type { InitUploadRequest, UploadedBlobTransportInput } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

export async function initUpload(
  ownerUserId: string,
  input: InitUploadRequest,
): Promise<{ fileId: string; status: "uploading" }> {
  const file = await db.file.create({
    data: {
      ownerUserId,
      parentFolderId: input.parentFolderId ?? null,
      name: input.name ?? null,
      mimeType: input.mimeType ?? null,
      primaryManifestBlobId: null,
      status: "UPLOADING",
      totalBytes: BigInt(input.totalBytes),
      chunkCount: input.chunkCount,
    },
  });

  return { fileId: file.id, status: "uploading" };
}

// === Anonymous uploads (Phase 6) ===
//
// Owned by the stable system user (getSystemUserId) so every ownerUserId-
// scoped query above (deleteFile, moveFile, getUploadStatus, ...) keeps
// working unmodified once a file is claimed. isAnonymous + anonSessionId +
// expiresAt are the only new bits of state. See docs/hermes/concept.md 4.7.

export async function initAnonymousUpload(
  input: InitUploadRequest,
  anonSessionId: string | null,
): Promise<{ fileId: string; status: "uploading" }> {
  const systemUserId = await getSystemUserId();
  const expiresAt = new Date(Date.now() + config.anonymousTTLDays * 86_400_000);

  const file = await db.file.create({
    data: {
      ownerUserId: systemUserId,
      parentFolderId: null, // anonymous uploads never nest into a real user's folder tree
      name: input.name ?? null,
      mimeType: input.mimeType ?? null,
      primaryManifestBlobId: null,
      status: "UPLOADING",
      totalBytes: BigInt(input.totalBytes),
      chunkCount: input.chunkCount,
      isAnonymous: true,
      anonSessionId,
      expiresAt,
    },
  });

  return { fileId: file.id, status: "uploading" };
}

export async function commitAnonymousManifest(
  fileId: string,
  manifestBlobId: string,
  totalBytes: string,
  chunkCount: number,
  blobs: UploadedBlobTransportInput[],
): Promise<{ success: boolean }> {
  const systemUserId = await getSystemUserId();
  return commitManifest(systemUserId, fileId, manifestBlobId, totalBytes, chunkCount, blobs);
}

/** Files an anonymous browser session has uploaded — localStorage UUID, convenience only, not auth. */
export async function getAnonymousUploadsBySession(anonSessionId: string) {
  const systemUserId = await getSystemUserId();
  return db.file.findMany({
    where: { ownerUserId: systemUserId, anonSessionId, deletedAt: null, status: "READY" },
    orderBy: { createdAt: "desc" },
  });
}

/** Permanently removes anonymous files past their TTL. Run on a timer, see index.ts. */
export async function purgeExpiredAnonymousFiles(): Promise<number> {
  const files = await db.file.findMany({
    where: { isAnonymous: true, expiresAt: { lt: new Date() }, deletedAt: null },
  });
  let purged = 0;
  for (const file of files) {
    try {
      await purgeFileRecord({ id: file.id, ownerUserId: file.ownerUserId, previewBlobId: file.previewBlobId });
      purged++;
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), scope: "anon-ttl-sweep", type: "purge_failed",
        fileId: file.id, error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
}

export async function setFilePreview(
  ownerUserId: string,
  fileId: string,
  previewBlobId: string,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  const blob = await db.blobTransport.findUnique({ where: { blobId: previewBlobId } });
  if (!blob || blob.ownerUserId !== ownerUserId) throw new Error("Preview blob not found");

  await db.file.update({
    where: { id: fileId },
    data: { previewBlobId },
  });
  return true;
}

export async function commitManifest(
  ownerUserId: string,
  fileId: string,
  manifestBlobId: string,
  totalBytes: string,
  chunkCount: number,
  blobs: UploadedBlobTransportInput[],
): Promise<{ success: boolean }> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");
  if (file.status !== "UPLOADING") throw new Error("File is not in UPLOADING state");

  const manifestBlob = blobs.find((blob) => blob.blobId === manifestBlobId);
  if (!manifestBlob) throw new Error("Manifest blob not found in commit payload");

  await db.$transaction(async (tx) => {
    await tx.blobTransport.createMany({
      skipDuplicates: true,
      data: blobs.map((blob) => ({
        blobId: blob.blobId,
        ownerUserId,
        storageKind: blob.storageKind,
        storagePath: blob.storagePath,
        discordMessageId: blob.discordMessageId ?? null,
        discordChannelId: blob.discordChannelId ?? null,
        webhookId: blob.webhookId ?? null,
        sizeBytes: BigInt(blob.sizeBytes),
        contentHash: blob.contentHash ?? null,
        healthStatus: null,
        healthCheckedAt: null,
      })),
    });

    await tx.blobPlacement.createMany({
      skipDuplicates: true,
      data: blobs.map((blob) => ({
        blobId: blob.blobId,
        provider: blob.storageKind,
        poolRole: "PRIMARY" as const,
        status: "ACTIVE" as const,
        storagePath: blob.storagePath,
        messageId: blob.discordMessageId ?? null,
        locationId: blob.discordChannelId ?? null,
        senderId: blob.webhookId ?? null,
        activatedAt: new Date(),
      })),
    });

    const replicaKinds = getConfiguredReplicaKinds();
    if (replicaKinds.length > 0) {
      await tx.blobPlacement.createMany({
        skipDuplicates: true,
        data: blobs.flatMap((blob) =>
          replicaKinds.map((kind) => ({
            blobId: blob.blobId,
            provider: kind,
            poolRole: "REPLICA" as const,
            status: "PENDING" as const,
            storagePath: "pending://replica",
          })),
        ),
      });
    }

    await tx.file.update({
      where: { id: fileId },
      data: {
        primaryManifestBlobId: manifestBlobId,
        totalBytes: BigInt(totalBytes),
        chunkCount,
        status: "READY",
      },
    });
  });

  await pluginRegistry.emitAsync("file:uploaded", {
    fileId,
    userId: ownerUserId,
    mimeType: file.mimeType ?? "application/octet-stream",
    size: BigInt(totalBytes),
    sha256: manifestBlobId,
  });

  // Fire-and-forget: thumbnail generation runs off the request path so
  // commitManifest returns immediately. Failures are logged, not thrown.
  void generateThumbnailForFile(fileId).catch((error) => {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), scope: "files", type: "thumbnail_kickoff_failed",
      fileId, error: error instanceof Error ? error.message : String(error),
    }));
  });

  return { success: true };
}

export async function getUploadStatus(ownerUserId: string, fileId: string) {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  const blobs = await db.blobTransport.findMany({
    where: { ownerUserId, blobId: { startsWith: `${fileId}:` } },
    select: { blobId: true },
  });

  const uploadedChunkIndices: number[] = [];
  let hasManifest = false;
  for (const blob of blobs) {
    if (blob.blobId === `${fileId}:manifest`) {
      hasManifest = true;
      continue;
    }
    const match = blob.blobId.match(/:chunk:(\d+)$/);
    if (match) uploadedChunkIndices.push(Number(match[1]));
  }
  uploadedChunkIndices.sort((a: number, b: number) => a - b);

  return {
    fileId,
    status: file.status,
    chunkCount: file.chunkCount,
    uploadedChunkIndices,
    hasManifest,
  };
}

export async function deleteFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  await db.file.update({
    where: { id: fileId },
    data: { deletedAt: new Date() },
  });

  await db.share.deleteMany({ where: { fileId, ownerUserId } });
  await pluginRegistry.emitAsync("file:deleted", { fileId, userId: ownerUserId });
  return true;
}

export async function moveFile(
  ownerUserId: string,
  fileId: string,
  parentFolderId: string | null,
): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId } });
  if (!file) throw new Error("File not found");

  if (parentFolderId) {
    const folder = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!folder) throw new Error("Folder not found");
  }

  await db.file.update({ where: { id: fileId }, data: { parentFolderId } });
  return true;
}

// === Trash ===

type PurgeableFile = { id: string; ownerUserId: string; previewBlobId: string | null };
type PurgeableBlob = {
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId: string | null;
  discordChannelId: string | null;
  webhookId: string | null;
  placements?: PlacementRow[];
};

async function deleteBlobsBestEffort(blobs: PurgeableBlob[]): Promise<void> {
  const warn = (blobId: string, error: unknown) =>
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      scope: "trash-purge",
      type: "blob_delete_failed",
      blobId,
      error: error instanceof Error ? error.message : String(error),
    }));

  for (const blob of blobs) {
    const placements = blob.placements ?? [];
    if (placements.length === 0) {
      try {
        await getPoolFor(blob.storageKind).delete(placementFromBlobRecord(blob));
      } catch (error) {
        warn(blob.blobId, error);
      }
      continue;
    }

    for (const placement of placements) {
      if (placement.status === "PENDING" && !placement.messageId) continue;
      try {
        await getPoolFor(placement.provider, placement.poolRole as PoolRole).delete(
          placementFromRow(blob.blobId, blob.ownerUserId, placement),
        );
      } catch (error) {
        warn(blob.blobId, error);
      }
    }
  }
}

async function purgeFileRecord(file: PurgeableFile): Promise<void> {
  const blobs = await db.blobTransport.findMany({
    where: {
      ownerUserId: file.ownerUserId,
      OR: [
        { blobId: { startsWith: `${file.id}:` } },
        ...(file.previewBlobId ? [{ blobId: file.previewBlobId }] : []),
      ],
    },
    include: { placements: true },
  });

  await deleteBlobsBestEffort(blobs);

  await db.$transaction([
    db.blobTransport.deleteMany({ where: { blobId: { in: blobs.map((b) => b.blobId) } } }),
    db.share.deleteMany({ where: { fileId: file.id } }),
    db.file.delete({ where: { id: file.id } }),
  ]);
}

export async function getTrashedFiles(ownerUserId: string) {
  return db.file.findMany({
    where: { ownerUserId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
  });
}

export async function restoreFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: { not: null } } });
  if (!file) throw new Error("File not found in trash");

  let parentFolderId = file.parentFolderId;
  if (parentFolderId) {
    const parent = await db.folder.findFirst({ where: { id: parentFolderId, ownerUserId } });
    if (!parent) parentFolderId = null;
  }

  await db.file.update({ where: { id: fileId }, data: { deletedAt: null, parentFolderId } });
  return true;
}

export async function purgeFile(ownerUserId: string, fileId: string): Promise<boolean> {
  const file = await db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: { not: null } } });
  if (!file) throw new Error("File not found in trash");
  await purgeFileRecord(file);
  return true;
}

export async function emptyTrash(ownerUserId: string): Promise<number> {
  const files = await db.file.findMany({ where: { ownerUserId, deletedAt: { not: null } } });
  for (const file of files) await purgeFileRecord(file);
  return files.length;
}

export async function purgeExpiredTrash(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const files = await db.file.findMany({ where: { deletedAt: { lt: cutoff } } });

  let purged = 0;
  for (const file of files) {
    try {
      await purgeFileRecord(file);
      purged++;
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "trash-purge",
        type: "file_purge_failed",
        fileId: file.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
}

// === Abandoned uploads ===

export async function findStaleUploads(
  staleAfterMinutes = 60,
): Promise<Array<{ id: string; lastActivityAt: Date; blobCount: number }>> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);

  return db.$queryRaw<Array<{ id: string; lastActivityAt: Date; blobCount: number }>>`
    WITH candidates AS (
      SELECT id, "createdAt" FROM "File"
      WHERE status = 'UPLOADING' AND "deletedAt" IS NULL AND "createdAt" < ${cutoff}
    )
    SELECT c.id,
           COALESCE(MAX(bt."createdAt"), c."createdAt") AS "lastActivityAt",
           COUNT(bt."blobId")::int                      AS "blobCount"
    FROM candidates c
    LEFT JOIN "BlobTransport" bt ON bt."blobId" LIKE c.id || ':%'
    GROUP BY c.id, c."createdAt"
    HAVING COALESCE(MAX(bt."createdAt"), c."createdAt") < ${cutoff}
  `;
}

export async function purgeStaleUploads(staleAfterMinutes = 60): Promise<number> {
  const stale = await findStaleUploads(staleAfterMinutes);

  let purged = 0;
  for (const { id } of stale) {
    const file = await db.file.findUnique({ where: { id } });
    if (!file || file.status !== "UPLOADING" || file.deletedAt) continue;

    try {
      await purgeFileRecord(file);
      purged++;
    } catch (error) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "stale-upload-sweep",
        type: "file_purge_failed",
        fileId: id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
}

export async function getFiles(ownerUserId: string, parentFolderId: string | null) {
  return db.file.findMany({
    where: { ownerUserId, parentFolderId, deletedAt: null, status: "READY" },
    orderBy: { createdAt: "desc" },
  });
}

export async function getFile(ownerUserId: string, fileId: string) {
  return db.file.findFirst({ where: { id: fileId, ownerUserId, deletedAt: null } });
}

export async function getStorageUsage(ownerUserId: string) {
  const result = await db.file.aggregate({
    where: { ownerUserId, deletedAt: null, status: "READY" },
    _sum: { totalBytes: true },
    _count: true,
  });

  return {
    totalBytes: (result._sum.totalBytes ?? BigInt(0)).toString(),
    fileCount: result._count,
  };
}


type HealthCheckChunkStatus = "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED";

type HealthCheckChunkInfo = {
  id: string;
  index: number;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  messageId: string;
  webhookId: string;
  channelId: string | null;
  size: number;
  contentHash: string | null;
  healthStatus: string | null;
  healthCheckedAt: string | null;
};

type HealthCheckFileInfo = {
  fileId: string;
  fileName: string;
  chunkCount: number;
  chunks: HealthCheckChunkInfo[];
};

type HealthCheckSummary = {
  checked: number;
  healthy: number;
  missing: number;
  modified: number;
  skipped: number;
  durationMs: number;
};

type ChunkHealthUpdate = {
  chunkId: string;
  status: Exclude<HealthCheckChunkStatus, "SKIPPED">;
};

function parseChunkIndex(blobId: string): number {
  const m = /:chunk:(\d+)$/.exec(blobId);
  return m ? Number(m[1]) : 0;
}

export async function getFilesForHealthCheckDisplay(
  ownerUserId: string,
): Promise<HealthCheckFileInfo[]> {
  const files = await db.file.findMany({
    where: { ownerUserId, deletedAt: null, status: "READY" },
    select: { id: true, chunkCount: true },
    orderBy: { createdAt: "desc" },
  });

  const result = await Promise.all(files.map(async (file) => {
    const chunks = await db.blobTransport.findMany({
      where: { ownerUserId, blobId: { startsWith: `${file.id}:chunk:` } },
      select: { blobId: true, healthStatus: true, healthCheckedAt: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      fileId: file.id,
      fileName: file.id,
      chunkCount: file.chunkCount,
      chunks: chunks.map((chunk: { blobId: string; healthStatus: string | null; healthCheckedAt: Date | null }) => ({
        id: chunk.blobId,
        index: parseChunkIndex(chunk.blobId),
        storageKind: "DISCORD" as const,
        storagePath: "",
        messageId: "",
        webhookId: "",
        channelId: null,
        size: 0,
        contentHash: null,
        healthStatus: chunk.healthStatus ?? null,
        healthCheckedAt: chunk.healthCheckedAt ? chunk.healthCheckedAt.toISOString() : null,
      })),
    } satisfies HealthCheckFileInfo;
  }));

  return result;
}

export async function getFilesForHealthCheck(
  ownerUserId: string,
  samplePercent?: number | null,
  fileId?: string | null,
): Promise<HealthCheckFileInfo[]> {
  let files = await db.file.findMany({
    where: {
      ownerUserId,
      deletedAt: null,
      status: "READY",
      ...(fileId ? { id: fileId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const pct = samplePercent ?? 100;
  if (!fileId && pct < 100) {
    const sampleSize = Math.max(1, Math.ceil(files.length * (pct / 100)));
    files = files
      .map((file) => ({ sortKey: Math.random(), file }))
      .sort((a: { sortKey: number }, b: { sortKey: number }) => a.sortKey - b.sortKey)
      .slice(0, sampleSize)
      .map((entry) => entry.file);
  }

  const result = await Promise.all(files.map(async (file) => {
    const chunks = await db.blobTransport.findMany({
      where: {
        ownerUserId,
        blobId: { startsWith: `${file.id}:chunk:` },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      fileId: file.id,
      fileName: file.id,
      chunkCount: file.chunkCount,
      chunks: chunks
        .map((chunk: typeof chunks[number]) => ({
          id: chunk.blobId,
          index: parseChunkIndex(chunk.blobId),
          storageKind: chunk.storageKind,
          storagePath: chunk.storagePath,
          messageId: chunk.discordMessageId ?? "",
          webhookId: chunk.webhookId ?? "",
          channelId: chunk.discordChannelId ?? null,
          size: Number(chunk.sizeBytes),
          contentHash: chunk.contentHash ?? null,
          healthStatus: chunk.healthStatus ?? null,
          healthCheckedAt: chunk.healthCheckedAt ? chunk.healthCheckedAt.toISOString() : null,
        }))
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index),
    } satisfies HealthCheckFileInfo;
  }));

  return result;
}

export async function updateChunkHealthBatch(
  ownerUserId: string,
  updates: ChunkHealthUpdate[],
): Promise<boolean> {
  const checkedAt = new Date();
  const placementStatus = { HEALTHY: "ACTIVE", MISSING: "MISSING", MODIFIED: "MODIFIED" } as const;
  await db.$transaction(
    updates.flatMap((update) => [
      db.blobTransport.updateMany({
        where: { blobId: update.chunkId, ownerUserId },
        data: { healthStatus: update.status, healthCheckedAt: checkedAt },
      }),
      db.blobPlacement.updateMany({
        where: {
          blobId: update.chunkId,
          poolRole: "PRIMARY",
          blob: { ownerUserId },
          status: { in: ["ACTIVE", "MISSING", "MODIFIED"] },
        },
        data: { status: placementStatus[update.status], healthCheckedAt: checkedAt },
      }),
    ]),
  );
  return true;
}

// === Replication status ===

export async function getReplicationStatus(ownerUserId: string) {
  const [groups, oldestPending, failedPlacements] = await Promise.all([
    db.blobPlacement.groupBy({
      by: ["provider", "poolRole", "status"],
      where: { blob: { ownerUserId } },
      _count: { _all: true },
    }),
    db.blobPlacement.findFirst({
      where: { blob: { ownerUserId }, status: { in: ["PENDING", "MISSING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.blobPlacement.count({
      where: { blob: { ownerUserId }, status: { in: ["PENDING", "MISSING"] }, attemptCount: { gte: 8 } },
    }),
  ]);

  const replicaKinds = getConfiguredReplicaKinds();
  const queueDepth = groups
    .filter((g: typeof groups[number]) => g.status === "PENDING" || g.status === "MISSING")
    .reduce((sum: number, g: typeof groups[number]) => sum + g._count._all, 0);

  return {
    enabled: replicaKinds.length > 0,
    replicaProviders: replicaKinds,
    queueDepth,
    oldestQueuedAgeSeconds: oldestPending
      ? Math.floor((Date.now() - oldestPending.createdAt.getTime()) / 1000)
      : null,
    failedPlacements,
    placements: groups.map((g: typeof groups[number]) => ({
      provider: g.provider,
      poolRole: g.poolRole,
      status: g.status,
      count: g._count._all,
    })),
  };
}

export async function runHealthCheck(
  ownerUserId: string,
  mode: string,
  samplePercent?: number | null,
  fileId?: string | null,
): Promise<HealthCheckSummary> {
  if (mode !== "exists" && mode !== "integrity") {
    throw new Error('Invalid health check mode. Use "exists" or "integrity".');
  }

  const files = await getFilesForHealthCheck(ownerUserId, samplePercent, fileId);
  const allChunks = files.flatMap((file) => file.chunks.map((chunk) => ({ ...chunk, fileId: file.fileId, fileName: file.fileName })));

  const webhookUrls = Object.entries(process.env)
    .filter(([key]) => /^WEBHOOK_\d+$/.test(key))
    .map(([, value]) => value as string)
    .filter(Boolean);

  if (webhookUrls.length === 0) {
    throw new Error("No WEBHOOK_* env vars found.");
  }

  const webhookMap = new Map<string, WebhookInfo>(parseWebhookUrls(webhookUrls).map((w) => [w.id, w]));

  const botMap = new Map<string, BotInfo>();
  for (let i = 1; i <= 20; i++) {
    const token = process.env[`BOT_${i}`]?.trim();
    const channelId = process.env[`BOT_${i}_CHANNEL`]?.trim();
    if (token && channelId) {
      botMap.set(`BOT_${i}`, { id: `BOT_${i}`, token, channelId });
    }
  }

  const rateLimiter = new WebhookRateLimiter();
  const startedAt = performance.now();

  const CONCURRENCY = 5;
  const FLUSH_EVERY = 50;
  const CHUNK_TIMEOUT_MS = 60_000;
  const RUN_TIMEOUT_MS = 5 * 60 * 1000;

  type ChunkResult = { chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED" };

  const abortController = new AbortController();
  const runTimeoutHandle = setTimeout(() => abortController.abort(), RUN_TIMEOUT_MS);

  const checkChunk = async (chunk: typeof allChunks[number]): Promise<ChunkResult> => {
    if (abortController.signal.aborted) return { chunkId: chunk.id, status: "SKIPPED" };
    try {
      if (chunk.storageKind === "LOCAL") {
        if (mode === "exists") {
          await stat(chunk.storagePath);
          return { chunkId: chunk.id, status: "HEALTHY" };
        }
        if (!chunk.contentHash) return { chunkId: chunk.id, status: "SKIPPED" };
        const data = await readFile(chunk.storagePath);
        const hash = createHash("sha256").update(data).digest("hex");
        return { chunkId: chunk.id, status: hash === chunk.contentHash ? "HEALTHY" : "MODIFIED" };
      }

      if (chunk.webhookId.startsWith("BOT_")) {
        const bot = botMap.get(chunk.webhookId);
        if (!bot) return { chunkId: chunk.id, status: "SKIPPED" };
        const botChannelId = chunk.channelId ?? bot.channelId;
        if (mode === "exists") {
          await getChunkUrlBot(bot, chunk.messageId, botChannelId, rateLimiter);
          return { chunkId: chunk.id, status: "HEALTHY" };
        }
        if (!chunk.contentHash) return { chunkId: chunk.id, status: "SKIPPED" };
        const stream = await downloadChunkBot(bot, chunk.messageId, botChannelId, rateLimiter);
        const reader = stream.getReader();
        const hasher = createHash("sha256");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
        }
        const hash = hasher.digest("hex");
        return { chunkId: chunk.id, status: hash === chunk.contentHash ? "HEALTHY" : "MODIFIED" };
      }

      const webhook = webhookMap.get(chunk.webhookId);
      if (!webhook) return { chunkId: chunk.id, status: "SKIPPED" };
      if (mode === "exists") {
        await getChunkUrl(webhook, chunk.messageId, rateLimiter);
        return { chunkId: chunk.id, status: "HEALTHY" };
      }
      if (!chunk.contentHash) return { chunkId: chunk.id, status: "SKIPPED" };
      const stream = await downloadChunk(webhook, chunk.messageId, rateLimiter);
      const reader = stream.getReader();
      const hasher = createHash("sha256");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      const hash = hasher.digest("hex");
      return { chunkId: chunk.id, status: hash === chunk.contentHash ? "HEALTHY" : "MODIFIED" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const isNotFound = msg.includes("not found") || msg.includes("404");
      return { chunkId: chunk.id, status: isNotFound ? "MISSING" : "SKIPPED" };
    }
  };

  const allResults: ChunkResult[] = [];
  const pendingFlush: Array<{ chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" }> = [];
  let cursor = 0;

  const flushPending = async () => {
    if (pendingFlush.length === 0) return;
    const batch = pendingFlush.splice(0, pendingFlush.length);
    await updateChunkHealthBatch(ownerUserId, batch);
  };

  const checkChunkWithTimeout = (chunk: typeof allChunks[number]): Promise<ChunkResult> =>
    Promise.race([
      checkChunk(chunk),
      new Promise<ChunkResult>((resolve) =>
        setTimeout(() => resolve({ chunkId: chunk.id, status: "SKIPPED" }), CHUNK_TIMEOUT_MS),
      ),
    ]);

  const worker = async () => {
    while (true) {
      if (abortController.signal.aborted) break;
      const i = cursor++;
      if (i >= allChunks.length) break;
      const result = await checkChunkWithTimeout(allChunks[i]!);
      allResults.push(result);
      if (result.status !== "SKIPPED") {
        pendingFlush.push({ chunkId: result.chunkId, status: result.status });
        if (pendingFlush.length >= FLUSH_EVERY) await flushPending();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allChunks.length || 1) }, worker));
  clearTimeout(runTimeoutHandle);
  await flushPending();

  return {
    checked: allResults.filter((r) => r.status !== "SKIPPED").length,
    healthy: allResults.filter((r) => r.status === "HEALTHY").length,
    missing: allResults.filter((r) => r.status === "MISSING").length,
    modified: allResults.filter((r) => r.status === "MODIFIED").length,
    skipped: allResults.filter((r) => r.status === "SKIPPED").length,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
