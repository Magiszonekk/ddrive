// ddrive — Anonymous upload pipeline (Phase 6)
//
// Same chunking approach as the authenticated uploadFile, but talks to the
// no-auth GraphQL mutations + /api/anon-blob/ endpoint. Simpler than
// upload.ts on purpose — no resume/retry sophistication, this is for casual
// "drop a file, get a link" use. See docs/hermes/concept.md section 4.7.

import { chunkFileStream } from "@ddv4/processing";
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
  mutation CommitAnonymousManifest($fileId: ID!, $manifestBlobId: String!, $totalBytes: String!, $chunkCount: Int!, $blobs: [UploadedBlobTransportInput!]!) {
    commitAnonymousManifest(fileId: $fileId, manifestBlobId: $manifestBlobId, totalBytes: $totalBytes, chunkCount: $chunkCount, blobs: $blobs) {
      success
    }
  }
`;

const CREATE_SHARE_FOR_ANON = `
  mutation CreateShareForAnon($fileId: ID!, $allowContent: Boolean!, $allowPreview: Boolean) {
    createShare(fileId: $fileId, allowContent: $allowContent, allowPreview: $allowPreview) {
      shareId token
    }
  }
`;

export interface AnonymousUploadResult {
  fileId: string;
  shareUrl: string;
}

export async function uploadAnonymousFile(
  file: File,
  anonSessionId: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
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
    },
  );
  const fileId = initAnonymousUpload.fileId;

  const uploadedBlobs: UploadedBlobTransportInput[] = [];
  let uploadedBytes = 0;

  for await (const chunk of chunkFileStream(file, LEGACY_UPLOAD_CHUNK_SIZE_BYTES)) {
    const blobId = `${fileId}:chunk:${chunk.index}`;
    const buffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
    const result = await uploadAnonymousBlobToApi(blobId, buffer, {
      "X-Anon-Session-Id": anonSessionId,
      "X-Chunk-Index": String(chunk.index),
      "X-Chunk-Count": String(chunkCount),
    });
    uploadedBlobs.push({
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
  }

  const manifestBlobId = `${fileId}:chunk:${chunkCount - 1}`;
  await gqlRequest(COMMIT_ANON_MANIFEST, {
    fileId,
    manifestBlobId,
    totalBytes: String(file.size),
    chunkCount,
    blobs: uploadedBlobs,
  });

  // Anonymous uploads are only reachable through a share link — there's no
  // "my files" view without an account — so we mint one immediately.
  const isPreviewable = /^(image|video|audio)\//.test(file.type);
  const { createShare } = await gqlRequest<{ createShare: { shareId: string; token: string } }>(
    CREATE_SHARE_FOR_ANON,
    { fileId, allowContent: true, allowPreview: isPreviewable },
  );

  const shareUrl = `${window.location.origin}/s/${createShare.shareId}?t=${createShare.token}`;
  return { fileId, shareUrl };
}
