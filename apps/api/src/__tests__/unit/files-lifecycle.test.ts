import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";
import { buildSchema } from "../../schema.js";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const {
  initUpload,
  commitManifest,
  getUploadStatus,
  getFiles,
  setFilePreview,
  deleteFile,
  restoreFile,
  purgeFile,
  getTrashedFiles,
} = await import("../../resolvers/files.js");
const { pluginRegistry } = await import("../../plugin-registry.js");

const ownerUserId = "user_files_lifecycle";
const otherUserId = "user_files_lifecycle_other";
const folderId = "folder_files_lifecycle";

async function resetFixtures() {
  await db.blobTransport.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.file.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.folder.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [ownerUserId, otherUserId] } } });

  for (const userId of [ownerUserId, otherUserId]) {
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        username: userId,
        passwordHash: `password-hash-${userId}`,
      },
    });
  }

  await db.folder.create({
    data: {
      id: folderId,
      ownerUserId,
      name: "lifecycle-folder",
    },
  });
}

function manifestBlobInput(blobId: string) {
  return {
    blobId,
    storageKind: "LOCAL" as const,
    storagePath: `/tmp/${blobId}`,
    sizeBytes: "100",
  };
}

describe("secure file lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetFixtures();
  });

  it("exposes the plaintext file metadata contract on the initUpload mutation", async () => {
    const schema = buildSchema();
    const mutationType = schema.getMutationType();
    const initUploadField = mutationType?.getFields().initUpload;

    expect(initUploadField).toBeDefined();
    expect(initUploadField?.args.map((arg) => arg.name)).toEqual([
      "parentFolderId",
      "name",
      "mimeType",
      "totalBytes",
      "chunkCount",
    ]);
    // The old zero-knowledge crypto contract fields must never come back
    expect(initUploadField?.args.some((arg) => arg.name === "wrappedFEK")).toBe(false);
    expect(initUploadField?.args.some((arg) => arg.name === "wrappedFEKPreview")).toBe(false);
    expect(initUploadField?.args.some((arg) => arg.name === "dedupeTokenB64")).toBe(false);
    expect(initUploadField?.args.some((arg) => arg.name === "encryptedName")).toBe(false);
    expect(initUploadField?.args.some((arg) => arg.name === "encryptedMimeType")).toBe(false);
  });

  it("initUpload creates an UPLOADING file with the given metadata", async () => {
    const input = {
      parentFolderId: folderId,
      name: "lifecycle.bin",
      mimeType: "application/octet-stream",
      totalBytes: "12345",
      chunkCount: 7,
    };

    const result = await initUpload(ownerUserId, input);
    const saved = await db.file.findUniqueOrThrow({ where: { id: result.fileId } });

    expect(result).toEqual({ fileId: result.fileId, status: "uploading" });
    expect(saved.ownerUserId).toBe(ownerUserId);
    expect(saved.parentFolderId).toBe(folderId);
    expect(saved.primaryManifestBlobId).toBeNull();
    expect(saved.previewBlobId).toBeNull();
    expect(saved.status).toBe("UPLOADING");
    expect(saved.totalBytes.toString()).toBe("12345");
    expect(saved.chunkCount).toBe(7);
    expect(saved.name).toBe(input.name);
    expect(saved.mimeType).toBe(input.mimeType);
  });

  it("commitManifest sets manifest blob and moves file from UPLOADING to READY", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 2,
    });

    await expect(
      commitManifest(ownerUserId, fileId, "manifest-blob-1", "100", 2, [manifestBlobInput("manifest-blob-1")]),
    ).resolves.toEqual({ success: true });

    const saved = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(saved.primaryManifestBlobId).toBe("manifest-blob-1");
    expect(saved.status).toBe("READY");
    expect(saved.totalBytes.toString()).toBe("100");
    expect(saved.chunkCount).toBe(2);
    expect(pluginRegistry.emitAsync).toHaveBeenCalledWith("file:uploaded", {
      fileId,
      userId: ownerUserId,
      mimeType: "application/octet-stream",
      size: BigInt(100),
      sha256: "manifest-blob-1",
    });
  });

  it("commitManifest rejects files that are no longer in UPLOADING state", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 2,
    });

    await commitManifest(ownerUserId, fileId, "manifest-blob-2", "100", 2, [manifestBlobInput("manifest-blob-2")]);

    await expect(
      commitManifest(ownerUserId, fileId, "manifest-blob-2", "100", 2, [manifestBlobInput("manifest-blob-2")]),
    ).rejects.toThrow("File is not in UPLOADING state");
  });

  it("commitManifest rejects a manifest blob missing from the commit payload", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 2,
    });

    await expect(
      commitManifest(ownerUserId, fileId, "manifest-blob-3", "100", 2, [manifestBlobInput("some-other-blob")]),
    ).rejects.toThrow("Manifest blob not found in commit payload");

    const saved = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(saved.primaryManifestBlobId).toBeNull();
    expect(saved.status).toBe("UPLOADING");
  });

  it("uploadStatus reports stored chunk indices and manifest presence for resume", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "300",
      chunkCount: 3,
    });

    await db.blobTransport.createMany({
      data: [
        { blobId: `${fileId}:chunk:0`, ownerUserId, storageKind: "LOCAL", storagePath: "/tmp/c0", sizeBytes: BigInt(100) },
        { blobId: `${fileId}:chunk:2`, ownerUserId, storageKind: "LOCAL", storagePath: "/tmp/c2", sizeBytes: BigInt(100) },
      ],
    });

    const status = await getUploadStatus(ownerUserId, fileId);
    expect(status.uploadedChunkIndices).toEqual([0, 2]);
    expect(status.hasManifest).toBe(false);
    expect(status.status).toBe("UPLOADING");
    expect(status.chunkCount).toBe(3);
  });

  it("getFiles lists only READY, non-deleted files and is scoped per owner", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 1,
    });

    // UPLOADING files aren't visible in listings yet
    expect((await getFiles(ownerUserId, null)).map((f) => f.id)).not.toContain(fileId);

    await commitManifest(ownerUserId, fileId, "manifest-list", "100", 1, [manifestBlobInput("manifest-list")]);

    expect((await getFiles(ownerUserId, null)).map((f) => f.id)).toContain(fileId);
    expect((await getFiles(otherUserId, null)).map((f) => f.id)).not.toContain(fileId);
  });

  it("setFilePreview attaches an uploaded preview blob to the file", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 1,
    });
    await commitManifest(ownerUserId, fileId, "manifest-prev", "100", 1, [manifestBlobInput("manifest-prev")]);

    const previewBlobId = `${fileId}:preview`;
    await db.blobTransport.create({
      data: { blobId: previewBlobId, ownerUserId, storageKind: "LOCAL", storagePath: "/tmp/prev", sizeBytes: BigInt(10) },
    });

    await expect(setFilePreview(ownerUserId, fileId, previewBlobId)).resolves.toBe(true);

    const saved = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(saved.previewBlobId).toBe(previewBlobId);
  });

  it("setFilePreview rejects preview blobs owned by someone else", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 1,
    });

    await db.blobTransport.create({
      data: { blobId: "foreign-preview", ownerUserId: otherUserId, storageKind: "LOCAL", storagePath: "/tmp/fp", sizeBytes: BigInt(10) },
    });

    await expect(setFilePreview(ownerUserId, fileId, "foreign-preview")).rejects.toThrow(
      "Preview blob not found",
    );
  });

  it("trash lifecycle: soft delete, list, restore", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      parentFolderId: folderId,
      totalBytes: "100",
      chunkCount: 1,
    });
    await commitManifest(ownerUserId, fileId, "manifest-trash", "100", 1, [manifestBlobInput("manifest-trash")]);

    await deleteFile(ownerUserId, fileId);
    const trashed = await getTrashedFiles(ownerUserId);
    expect(trashed.map((f) => f.id)).toContain(fileId);

    await expect(restoreFile(ownerUserId, fileId)).resolves.toBe(true);
    const restored = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(restored.deletedAt).toBeNull();
    expect(restored.parentFolderId).toBe(folderId);
    expect(await getTrashedFiles(ownerUserId)).toEqual([]);
  });

  it("restoreFile falls back to root when the original folder is gone", async () => {
    const tempFolder = await db.folder.create({
      data: { ownerUserId, name: "temp-folder" },
    });
    const { fileId } = await initUpload(ownerUserId, {
      parentFolderId: tempFolder.id,
      totalBytes: "100",
      chunkCount: 1,
    });
    await commitManifest(ownerUserId, fileId, "manifest-orph", "100", 1, [manifestBlobInput("manifest-orph")]);

    await deleteFile(ownerUserId, fileId);
    await db.folder.delete({ where: { id: tempFolder.id } });

    await restoreFile(ownerUserId, fileId);
    const restored = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(restored.parentFolderId).toBeNull();
  });

  it("purgeFile hard-deletes the file record and its blob transport rows", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 1,
    });
    await commitManifest(ownerUserId, fileId, `${fileId}:manifest`, "100", 1, [
      manifestBlobInput(`${fileId}:manifest`),
      manifestBlobInput(`${fileId}:chunk:0`),
    ]);

    await deleteFile(ownerUserId, fileId);
    await expect(purgeFile(ownerUserId, fileId)).resolves.toBe(true);

    expect(await db.file.findUnique({ where: { id: fileId } })).toBeNull();
    expect(await db.blobTransport.findMany({ where: { blobId: { startsWith: `${fileId}:` } } })).toEqual([]);
  });

  it("purgeFile refuses files that are not in trash", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      totalBytes: "100",
      chunkCount: 1,
    });
    await commitManifest(ownerUserId, fileId, "manifest-live", "100", 1, [manifestBlobInput("manifest-live")]);

    await expect(purgeFile(ownerUserId, fileId)).rejects.toThrow("File not found in trash");
  });
});
