// ddrive — Anonymous upload pipeline (Phase 6)
//
// Same chunking approach as the authenticated uploadFile, but talks to the
// no-auth GraphQL mutations + /api/anon-blob/ endpoint. No resume/retry
// sophistication (this is for casual "drop a file, get a link" use), but
// DOES upload chunks concurrently — a worker pool pulls from a shared
// streaming iterator, same pattern as upload.ts. See
// docs/hermes/concept.md section 4.7.

import { chunkFileStream } from "@ddv4/processing";
import { config } from "@ddv4/config";
import { gqlRequest } from "./graphql.js";
import { uploadAnonymousBlobToApi } from "./api.js";
import { LEGACY_UPLOAD_CHUNK_SIZE_BYTES } from "./upload-constants.js";
import type { UploadedBlobTransportInput } from "@ddv4/types/api";

const INIT_ANON_UPLOAD = `
  mutation InitAnonymousUpload($name: String, $mimeType: String, $totalBytes: String!, $chunkCount: Int!, $anonSessionId: String) {
    initAnonymousUpload(name: $name, mimeType: $mimeType, totalBytes: $totalBytes, chunkCount: $chunkCount, anonSessionId: $anonSessionId) {
      fileId status
    }
  }
`;

const COMMIT_ANON_MANIFEST = `
  mutation CommitAnonymousManifest($fileId: ID!, $manifestBlobId: String!, $totalBytes: String!, $chunkCount: Int!, $blobs: [UploadedBlobTransportInput!]!, $parentFolderId: ID) {
    commitAnonymousManifest(fileId: $fileId, manifestBlobId: $manifestBlobId, totalBytes: $totalBytes, chunkCount: $chunkCount, blobs: $blobs, parentFolderId: $parentFolderId) {
      success
    }
  }
`;

const CREATE_SHARE_FOR_ANON = `
  mutation CreateShareForAnon($fileId: ID!, $allowContent: Boolean!, $allowPreview: Boolean) {
    createAnonymousShare(fileId: $fileId, allowContent: $allowContent, allowPreview: $allowPreview) {
      shareId token
    }
  }
`;

export interface AnonymousUploadResult {
  fileId: string;
  shareUrl?: string;
}

export async function uploadAnonymousFile(
  file: File,
  anonSessionId: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  parentFolderId: string | null = null,
): Promise<AnonymousUploadResult> {
  const chunkCount = Math.ceil(file.size / LEGACY_UPLOAD_CHUNK_SIZE_BYTES);

  const { initAnonymousUpload } = await gqlRequest<{ initAnonymousUpload: { fileId: string } }>(
    INIT_ANON_UPLOAD,
    {
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      totalBytes: String(file.size),
      chunkCount,
      anonSessionId,
      parentFolderId,
    },
  );
  const fileId = initAnonymousUpload.fileId;

  // Chunks uploaded so far, keyed by index — a Map (not an array push) so
  // concurrent workers landing out of order still assemble correctly.
  const uploadedBlobs = new Map<number, UploadedBlobTransportInput>();
  let uploadedBytes = 0;

  const CONCURRENCY = Math.min(config.defaultUploadConcurrency, chunkCount);

  // Workers share one streaming iterator through a mutex, same pattern as
  // upload.ts — chunkFileStream reads the file incrementally so nothing
  // requires the whole file to be buffered in memory up front.
  const chunkIter = chunkFileStream(file, LEGACY_UPLOAD_CHUNK_SIZE_BYTES)[Symbol.asyncIterator]();
  let iterLocked = false;
  const iterWaiters: Array<() => void> = [];
  const nextChunk = async (): Promise<{ index: number; data: Uint8Array } | null> => {
    while (iterLocked) {
      await new Promise<void>((resolve) => iterWaiters.push(resolve));
    }
    iterLocked = true;
    try {
      const result = await chunkIter.next();
      return result.done ? null : result.value;
    } finally {
      iterLocked = false;
      iterWaiters.shift()?.();
    }
  };

  const uploadOneChunk = async (chunk: { index: number; data: Uint8Array }) => {
    const blobId = `${fileId}:chunk:${chunk.index}`;
    const buffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
    const result = await uploadAnonymousBlobToApi(blobId, buffer, {
      "X-Anon-Session-Id": anonSessionId,
      "X-Chunk-Index": String(chunk.index),
      "X-Chunk-Count": String(chunkCount),
    });
    uploadedBlobs.set(chunk.index, {
      blobId: result.blobId,
      sizeBytes: result.sizeBytes,
      contentHash: result.contentHash,
      storageKind: result.storageKind,
      storagePath: result.storagePath,
      discordMessageId: result.discordMessageId,
      discordChannelId: result.discordChannelId,
      webhookId: result.webhookId,
    });
    uploadedBytes += chunk.data.byteLength;
    onProgress?.(uploadedBytes, file.size);
  };

  const worker = async () => {
    while (true) {
      const chunk = await nextChunk();
      if (!chunk) break;
      await uploadOneChunk(chunk);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const orderedBlobs = Array.from({ length: chunkCount }, (_, i) => uploadedBlobs.get(i)!);
  const manifestBlobId = `${fileId}:chunk:${chunkCount - 1}`;
  await gqlRequest(COMMIT_ANON_MANIFEST, {
    fileId,
    manifestBlobId,
    totalBytes: String(file.size),
    chunkCount,
    blobs: orderedBlobs,
    parentFolderId,
  });

  return { fileId };
}
