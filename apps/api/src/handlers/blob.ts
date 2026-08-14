// ddrive v4 — Blob transport handlers

import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@ddv4/database";
import type { BlobTransportMetadataDto } from "@ddv4/types/api";
import { sha256Ciphertext } from "../storage/local-blobs.js";
import {
  getPoolFor,
  getPrimaryPool,
  orderPlacementsForRead,
  placementFromBlobRecord,
  placementFromRow,
  type PlacementRow,
  type PoolRole,
} from "../storage/provider.js";
import { getConfiguredReplicaKinds } from "../storage/replica-pools.js";
import { writeThroughReplication } from "../storage/replication-worker.js";
import { resolveRequestAuth, LeakedApiKeyError } from "../middleware/auth.js";

type BlobRecord = {
  blobId: string;
  ownerUserId: string;
  storageKind: string;
  storagePath: string;
  discordMessageId?: string | null;
  discordChannelId?: string | null;
  webhookId?: string | null;
  sizeBytes: bigint;
  contentHash: string | null;
  healthStatus: string | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
  placements?: PlacementRow[];
};

async function authOrResponse(
  req: Request,
): Promise<{ auth: { userId: string; email: string }; response?: never } | { auth?: never; response: Response }> {
  try {
    const auth = await resolveRequestAuth(req);
    if (!auth) return { response: Response.json({ error: "Authentication required" }, { status: 401 }) };
    return { auth };
  } catch (error) {
    if (error instanceof LeakedApiKeyError) {
      return { response: Response.json({ error: error.message }, { status: 400 }) };
    }
    return { response: Response.json({ error: "Authentication required" }, { status: 401 }) };
  }
}

function normalizeBlobUploadBody(body: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function toMetadataDto(blob: BlobRecord): BlobTransportMetadataDto {
  const base: BlobTransportMetadataDto = {
    blobId: blob.blobId,
    ownerUserId: blob.ownerUserId,
    storageKind: blob.storageKind as BlobTransportMetadataDto["storageKind"],
    storagePath: blob.storagePath,
    sizeBytes: blob.sizeBytes.toString(),
    contentHash: blob.contentHash ?? undefined,
    healthStatus: blob.healthStatus as BlobTransportMetadataDto["healthStatus"],
    healthCheckedAt: blob.healthCheckedAt?.toISOString(),
    createdAt: blob.createdAt.toISOString(),
  };

  if (blob.storageKind === "DISCORD") {
    base.discordMessageId = blob.discordMessageId ?? undefined;
    base.discordChannelId = blob.discordChannelId ?? undefined;
    base.webhookId = blob.webhookId ?? undefined;
  }

  return base;
}

function looksLikeMissing(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("not found") || msg.includes("404") || msg.includes("enoent");
}

export async function readBlobBytes(blob: BlobRecord): Promise<Uint8Array> {
  const candidates = orderPlacementsForRead(blob.placements ?? []);
  let lastError: unknown = null;

  for (const placement of candidates) {
    try {
      return await getPoolFor(placement.provider, placement.poolRole as PoolRole).get(
        placementFromRow(blob.blobId, blob.ownerUserId, placement),
      );
    } catch (error) {
      lastError = error;
      if (placement.id && looksLikeMissing(error)) {
        void db.blobPlacement
          .updateMany({
            where: { id: placement.id, status: { in: ["ACTIVE", "MODIFIED"] } },
            data: { status: "MISSING", healthCheckedAt: new Date(), attemptCount: 0, nextAttemptAt: null },
          })
          .catch(() => {});
      }
    }
  }

  if (candidates.length > 0) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return getPoolFor(blob.storageKind).get(placementFromBlobRecord(blob));
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function internalErrorResponse(error: unknown): Response {
  return Response.json({ error: asErrorMessage(error) }, { status: 500 });
}

function parseUploadTelemetryHeaders(req: Request): {
  uploadId: string | null;
  chunkIndex: string | null;
  chunkCount: string | null;
  clientTimestamp: string | null;
} {
  return {
    uploadId: req.headers.get("x-upload-id"),
    chunkIndex: req.headers.get("x-chunk-index"),
    chunkCount: req.headers.get("x-chunk-count"),
    clientTimestamp: req.headers.get("x-client-timestamp"),
  };
}

function logBlobUploadEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    scope: "blob-upload-debug",
    ...event,
  }));
}

function makeUploadRequestId(blobId: string, telemetry: ReturnType<typeof parseUploadTelemetryHeaders>): string {
  return [blobId, telemetry.uploadId ?? 'noupload', telemetry.chunkIndex ?? 'nochunk', Date.now().toString(36)].join(':');
}

export async function handleBlobMetadata(req: Request, params: { blobId: string }): Promise<Response> {
  const { auth, response } = await authOrResponse(req);
  if (!auth) return response;

  const blob = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
  if (!blob || blob.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  return Response.json(toMetadataDto(blob as BlobRecord));
}

export async function handleBlobContent(req: Request, params: { blobId: string }): Promise<Response> {
  const { auth, response } = await authOrResponse(req);
  if (!auth) return response;

  const blob = await db.blobTransport.findUnique({
    where: { blobId: params.blobId },
    include: { placements: true },
  });
  if (!blob || blob.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  try {
    const bytes = await readBlobBytes(blob as BlobRecord);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": bytes.byteLength.toString(),
      },
    });
  } catch (error) {
    return internalErrorResponse(error);
  }
}

function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function handleBlobContentForShare(req: Request, params: { blobId: string }): Promise<Response> {
  const shareId = req.headers.get("x-share-id");
  const shareToken = req.headers.get("x-share-token");
  if (!shareId || !shareToken) {
    return Response.json({ error: "Share credentials required" }, { status: 401 });
  }

  const share = await db.share.findUnique({
    where: { shareId },
  });
  if (!share) {
    return Response.json({ error: "Share not found" }, { status: 404 });
  }
  if (share.status === "REVOKED") {
    return Response.json({ error: "Share revoked" }, { status: 410 });
  }
  if (share.status !== "ACTIVE") {
    return Response.json({ error: "Share not active" }, { status: 404 });
  }
  if (share.expiresAt && share.expiresAt < new Date()) {
    return Response.json({ error: "Share expired" }, { status: 410 });
  }
  if (share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews) {
    return Response.json({ error: "Share view limit reached" }, { status: 410 });
  }

  const presented = Buffer.from(hashShareToken(shareToken), "hex");
  const stored = Buffer.from(share.tokenHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return Response.json({ error: "Invalid share token" }, { status: 403 });
  }

  const blob = await db.blobTransport.findUnique({
    where: { blobId: params.blobId },
    include: { placements: true },
  });
  if (!blob) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  if (blob.ownerUserId !== share.ownerUserId) {
    return Response.json({ error: "Blob not accessible via this share" }, { status: 403 });
  }

  try {
    const bytes = await readBlobBytes(blob as BlobRecord);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": bytes.byteLength.toString(),
      },
    });
  } catch (error) {
    return internalErrorResponse(error);
  }
}

export async function handleBlobUpload(req: Request, params: { blobId: string }): Promise<Response> {
  const { auth, response } = await authOrResponse(req);
  if (!auth) return response;

  const telemetry = parseUploadTelemetryHeaders(req);
  const requestId = makeUploadRequestId(params.blobId, telemetry);
  const requestStartMs = performance.now();

  const existing = await db.blobTransport.findUnique({ where: { blobId: params.blobId } });
  if (existing && existing.ownerUserId !== auth.userId) {
    return Response.json({ error: "Blob not found" }, { status: 404 });
  }

  try {
    logBlobUploadEvent({
      type: "blob_upload_received",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      contentLength: req.headers.get("content-length"),
    });

    const readBodyStartMs = performance.now();
    const content = normalizeBlobUploadBody(await req.arrayBuffer());
    const readBodyMs = performance.now() - readBodyStartMs;

    const sizeBytes = BigInt(content.byteLength);

    const hashStartMs = performance.now();
    const contentHash = sha256Ciphertext(content);
    const hashMs = performance.now() - hashStartMs;

    const pool = getPrimaryPool();
    const storageKind = pool.kind;

    const storeStartMs = performance.now();
    const written = await pool.put(auth.userId, params.blobId, content, {
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
    });
    const storeMs = performance.now() - storeStartMs;

    const storagePath = written.storagePath;
    const discordMessageId = written.messageId;
    const discordChannelId = written.locationId;
    const webhookId = written.senderId;

    const transportData = {
      ownerUserId: auth.userId,
      storageKind,
      storagePath,
      ...(storageKind === "DISCORD" ? { discordMessageId, discordChannelId, webhookId } : {}),
      sizeBytes,
      contentHash,
    };
    const placementCoordinates = {
      status: "ACTIVE" as const,
      storagePath,
      messageId: discordMessageId,
      locationId: discordChannelId,
      senderId: webhookId,
      activatedAt: new Date(),
    };
    const replicaKinds = getConfiguredReplicaKinds();
    await db.$transaction([
      db.blobTransport.upsert({
        where: { blobId: params.blobId },
        create: { blobId: params.blobId, ...transportData },
        update: { ...transportData, healthStatus: null, healthCheckedAt: null },
      }),
      db.blobPlacement.deleteMany({
        where: { blobId: params.blobId, poolRole: "PRIMARY", NOT: { provider: storageKind } },
      }),
      db.blobPlacement.upsert({
        where: {
          blobId_provider_poolRole: {
            blobId: params.blobId,
            provider: storageKind,
            poolRole: "PRIMARY",
          },
        },
        create: {
          blobId: params.blobId,
          provider: storageKind,
          poolRole: "PRIMARY",
          ...placementCoordinates,
        },
        update: { ...placementCoordinates, attemptCount: 0, lastError: null },
      }),
      ...(replicaKinds.length > 0
        ? [
            db.blobPlacement.updateMany({
              where: {
                blobId: params.blobId,
                poolRole: "REPLICA",
                status: { in: ["ACTIVE", "MISSING", "MODIFIED"] },
              },
              data: { status: "PENDING", attemptCount: 0, nextAttemptAt: null },
            }),
            db.blobPlacement.createMany({
              skipDuplicates: true,
              data: replicaKinds.map((kind) => ({
                blobId: params.blobId,
                provider: kind,
                poolRole: "REPLICA" as const,
                status: "PENDING" as const,
                storagePath: "pending://replica",
              })),
            }),
          ]
        : []),
    ]);

    if (replicaKinds.length > 0) {
      void writeThroughReplication(params.blobId, content).catch((error) => {
        logBlobUploadEvent({
          type: "write_through_failed",
          requestId,
          blobId: params.blobId,
          error: asErrorMessage(error),
        });
      });
    }

    logBlobUploadEvent({
      type: "blob_upload_completed",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      storageKind,
      webhookId,
      uploadTransportPath: written.diagnostics?.uploadTransportPath ?? null,
      uploadAttemptCount: written.diagnostics?.uploadAttemptCount ?? null,
      uploadUpstreamStatus: written.diagnostics?.uploadUpstreamStatus ?? null,
      uploadElapsedMs: written.diagnostics?.uploadElapsedMs ?? null,
      relayEgress: written.diagnostics?.relayEgress ?? null,
      limiterRemaining: written.diagnostics?.limiterRemaining ?? null,
      limiterInFlight: written.diagnostics?.limiterInFlight ?? null,
      sizeBytes: content.byteLength,
      readBodyMs: Number(readBodyMs.toFixed(2)),
      hashMs: Number(hashMs.toFixed(2)),
      storeMs: Number(storeMs.toFixed(2)),
      totalMs: Number((performance.now() - requestStartMs).toFixed(2)),
    });

    return Response.json({
      blobId: params.blobId,
      sizeBytes: sizeBytes.toString(),
      contentHash,
      storageKind,
      storagePath,
      discordMessageId: discordMessageId ?? undefined,
      discordChannelId: discordChannelId ?? undefined,
      webhookId: webhookId ?? undefined,
    });
  } catch (error) {
    logBlobUploadEvent({
      type: "blob_upload_failed",
      requestId,
      uploadId: telemetry.uploadId,
      chunkIndex: telemetry.chunkIndex,
      chunkCount: telemetry.chunkCount,
      clientTimestamp: telemetry.clientTimestamp,
      blobId: params.blobId,
      userId: auth.userId,
      totalMs: Number((performance.now() - requestStartMs).toFixed(2)),
      error: asErrorMessage(error),
    });
    return internalErrorResponse(error);
  }
}
