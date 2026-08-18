// ddrive v4 — Share resolvers (hashed-token model)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@ddv4/database";
import type { CreateFileShareRequest, ShareAccessResponse } from "@ddv4/types/api";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createShare(
  ownerUserId: string,
  input: CreateFileShareRequest,
): Promise<{ shareId: string; token: string }> {
  const file = await db.file.findFirst({
    where: { id: input.fileId, ownerUserId, deletedAt: null, status: "READY" },
  });
  if (!file) throw new Error("File not found or not ready");

  const token = randomBytes(32).toString("base64url");

  const share = await db.share.create({
    data: {
      ownerUserId,
      fileId: input.fileId,
      shareType: "FILE",
      tokenHash: hashToken(token),
      allowContent: input.allowContent,
      allowPreview: input.allowPreview ?? false,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      maxViews: input.maxViews ?? null,
    },
  });

  return { shareId: share.shareId, token };
}

export async function revokeShare(ownerUserId: string, shareId: string): Promise<boolean> {
  const share = await db.share.findFirst({ where: { shareId, ownerUserId } });
  if (!share) throw new Error("Share not found");

  await db.share.update({
    where: { shareId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return true;
}

export async function getShares(ownerUserId: string, fileId: string) {
  return db.share.findMany({
    where: { ownerUserId, fileId },
    orderBy: { createdAt: "desc" },
  });
}

export async function accessShare(
  shareId: string,
  presentedToken: string,
): Promise<ShareAccessResponse | null> {
  const share = await db.share.findUnique({
    where: { shareId },
    include: { file: true },
  });

  if (!share) return null;
  if (share.status !== "ACTIVE") return null;
  if (share.expiresAt && share.expiresAt < new Date()) return null;
  if (share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews) return null;

  const presented = Buffer.from(hashToken(presentedToken), "hex");
  const stored = Buffer.from(share.tokenHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return null;
  }

  await db.share.update({
    where: { shareId },
    data: { viewCount: { increment: 1 } },
  });

  return {
    shareId: share.shareId,
    fileId: share.fileId,
    name: share.file.name,
    mimeType: share.file.mimeType,
    primaryManifestBlobId: share.file.primaryManifestBlobId,
    previewBlobId: share.allowPreview ? share.file.previewBlobId : null,
    thumbnailBlobId: share.allowPreview ? share.file.thumbnailBlobId : null,
    posterBlobId: share.allowPreview ? share.file.posterBlobId : null,
    chunkCount: share.file.chunkCount,
    allowContent: share.allowContent,
    allowPreview: share.allowPreview,
  };
}
