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
  expiresAt?: string | null,
  maxViews?: number | null,
  anonSessionId?: string | null,
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
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      maxViews: maxViews ?? null,
      anonSessionId: anonSessionId ?? null,
    },
  });

  return { shareId: share.shareId, token };
}

/** Anonymous folder share (Phase 9): mint a share for an entire folder. */
export async function createAnonymousFolderShare(
  folderId: string,
  allowContent: boolean,
  allowPreview: boolean,
  expiresAt?: string | null,
  maxViews?: number | null,
  anonSessionId?: string | null,
): Promise<{ shareId: string; token: string }> {
  const folder = await db.folder.findFirst({
    where: { id: folderId, isAnonymous: true },
  });
  if (!folder) throw new Error("Folder not found or not anonymous");

  const token = randomBytes(32).toString("base64url");
  const share = await db.share.create({
    data: {
      ownerUserId: folder.ownerUserId,
      folderId,
      shareType: "FOLDER" as const,
      tokenHash: hashToken(token),
      allowContent,
      allowPreview,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      maxViews: maxViews ?? null,
      anonSessionId: anonSessionId ?? null,
    },
  });

  return { shareId: share.shareId, token };
}

export async function listAnonymousShares(anonSessionId: string) {
  return db.share.findMany({
    where: { anonSessionId },
    orderBy: { createdAt: "desc" },
  });
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

  // Folder shares: return the folder tree's immediate contents.
  if (share.shareType === "FOLDER" && share.folderId) {
    const folder = await db.folder.findUnique({ where: { id: share.folderId } });
    const [childFolders, childFiles] = await Promise.all([
      db.folder.findMany({
        where: { parentFolderId: share.folderId },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      }),
      db.file.findMany({
        where: { parentFolderId: share.folderId, deletedAt: null, status: "READY" },
        select: { id: true, name: true, mimeType: true, totalBytes: true, thumbnailBlobId: true, chunkCount: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const contents: Array<{
      id: string; name: string | null; mimeType: string | null;
      size: string; thumbnailBlobId: string | null; chunkCount: number; kind: "FILE" | "FOLDER";
    }> = [
      ...childFolders.map((f) => ({ id: f.id, name: f.name, mimeType: null, size: "0", thumbnailBlobId: null, chunkCount: 0, kind: "FOLDER" as const })),
      ...childFiles.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.totalBytes.toString(), thumbnailBlobId: f.thumbnailBlobId, chunkCount: f.chunkCount, kind: "FILE" as const })),
    ];
    return {
      shareId: share.shareId,
      shareType: "FOLDER",
      fileId: "",
      folderId: share.folderId,
      name: folder?.name ?? "Shared folder",
      mimeType: null,
      primaryManifestBlobId: null,
      previewBlobId: null,
      thumbnailBlobId: null,
      posterBlobId: null,
      chunkCount: 0,
      allowContent: share.allowContent,
      allowPreview: share.allowPreview,
      folderContents: contents,
    };
  }

  return {
    shareId: share.shareId,
    shareType: "FILE",
    fileId: share.fileId ?? "",
    folderId: null,
    name: share.file?.name ?? "Shared file",
    mimeType: share.file?.mimeType ?? null,
    primaryManifestBlobId: share.file?.primaryManifestBlobId ?? null,
    previewBlobId: share.file ? (share.allowPreview ? share.file.previewBlobId : null) : null,
    thumbnailBlobId: share.file ? (share.allowPreview ? share.file.thumbnailBlobId : null) : null,
    posterBlobId: share.file ? (share.allowPreview ? share.file.posterBlobId : null) : null,
    chunkCount: share.file?.chunkCount ?? 0,
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
  if (!share.file) throw new Error("This share has no file (folder shares cannot be claimed)");

  await db.file.update({
    where: { id: share.fileId ?? "" },
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
