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

/**
 * Share creation for anonymous uploads (Phase 6) — no ownerUserId check
 * since the file is owned by the system user, not a real account. Callable
 * without auth; the only gate is that the target file is actually
 * isAnonymous, so this can't be used to mint shares for someone else's
 * private files.
 */
export async function createAnonymousShare(
  fileId: string,
  allowContent: boolean,
  allowPreview: boolean,
): Promise<{ shareId: string; token: string }> {
  const file = await db.file.findFirst({
    where: { id: fileId, isAnonymous: true, deletedAt: null, status: "READY" },
  });
  if (!file) throw new Error("File not found, not anonymous, or not ready");

  const token = randomBytes(32).toString("base64url");

  const share = await db.share.create({
    data: {
      ownerUserId: file.ownerUserId,
      fileId,
      shareType: "FILE",
      tokenHash: hashToken(token),
      allowContent,
      allowPreview,
    },
  });

  return { shareId: share.shareId, token };
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

/**
 * Same lookup as accessShare, but for the server-rendered OG/embed page
 * (apps/api/src/handlers/share-page.ts) — no view-count increment (that
 * page loads on every unfurl bot hit, would inflate counts meaninglessly),
 * and it needs the raw File row (not the GraphQL DTO shape).
 */
export async function resolveShareForPage(shareId: string, presentedToken: string) {
  const share = await db.share.findUnique({ where: { shareId }, include: { file: true } });
  if (!share) return null;
  if (share.status !== "ACTIVE") return null;
  if (share.expiresAt && share.expiresAt < new Date()) return null;
  if (share.maxViews !== null && share.maxViews !== undefined && share.viewCount >= share.maxViews) return null;

  const presented = Buffer.from(hashToken(presentedToken), "hex");
  const stored = Buffer.from(share.tokenHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  return share;
}

// === Claim flow (Phase 6): anonymous share -> logged-in user's account ===

export async function claimShare(userId: string, shareId: string, presentedToken: string): Promise<boolean> {
  const share = await resolveShareForPage(shareId, presentedToken);
  if (!share) throw new Error("Share not found or expired");
  if (!share.file.isAnonymous) throw new Error("This file is already owned by an account");

  await db.file.update({
    where: { id: share.fileId },
    data: { ownerUserId: userId, isAnonymous: false, anonSessionId: null, expiresAt: null },
  });
  return true;
}

// === Report/abuse flow ===

export async function reportShare(
  shareId: string,
  reason: string,
  note: string | null,
  reporterIp: string | null,
): Promise<boolean> {
  const share = await db.share.findUnique({ where: { shareId } });
  if (!share) throw new Error("Share not found");

  await db.shareReport.create({
    data: { shareId, reason, note, reporterIp },
  });
  return true;
}

export async function listOpenReports() {
  return db.shareReport.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "desc" },
    include: { share: { include: { file: true } } },
  });
}

export async function resolveReport(reportId: string, status: "RESOLVED" | "DISMISSED"): Promise<boolean> {
  await db.shareReport.update({
    where: { id: reportId },
    data: { status, resolvedAt: new Date() },
  });
  return true;
}
