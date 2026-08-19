// ddrive — Download helpers
//
// Chunks arrive already decrypted (server holds the key) — no client-side
// crypto here anymore. See docs/hermes/concept.md section 4.1.

import { zipSync } from "fflate";
import { fetchBlobBody, fetchBlobBodyShared } from "./api.js";
import { gqlRequest } from "./graphql.js";
import { useDownloadStore } from "../stores/download.js";
import { DownloadStatus } from "@ddv4/types";

export const DOWNLOAD_SUCCESS_EVENT = "ddv4:download-started";

interface DownloadOptions {
  fileId: string;
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  anonSessionId?: string;
}

interface SharedDownloadOptions {
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  shareId?: string;
  shareToken?: string;
}

interface DownloadResult {
  fileName: string;
  bytes: number;
}

function emitDownloadStarted(detail: DownloadResult) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DOWNLOAD_SUCCESS_EVENT, { detail }));
  }
}

/** Owner download: fetch every chunk blob (already plaintext) and reassemble. */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const downloadStore = useDownloadStore.getState();
  const controller = new AbortController();
  downloadStore.registerController(options.fileId, controller);

  emitDownloadStarted({ fileName: options.fileName, bytes: 0 });

  try {
    downloadStore.updateDownload(options.fileId, { status: DownloadStatus.DOWNLOADING });

    const chunkBlobIds = await listChunkBlobIds(options.fileId);
    downloadStore.updateDownload(options.fileId, {
      status: DownloadStatus.DOWNLOADING,
      totalChunks: chunkBlobIds.length,
    });

    const chunks = await downloadChunksConcurrently(
      chunkBlobIds,
      (blobId, signal) => fetchBlobBody(blobId, signal, options.anonSessionId),
      controller.signal,
      (downloadedChunks, bytesDownloaded) =>
        downloadStore.updateDownload(options.fileId, { downloadedChunks, bytesDownloaded }),
    );

    saveBlob(chunks, options.fileName, options.mimeType);
    downloadStore.updateDownload(options.fileId, { status: DownloadStatus.DONE });
    return {
      fileName: options.fileName,
      bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
  } finally {
    // don't removeDownload here — let DownloadProgress auto-dismiss after 3s
  }
}

/** Share-link download: same idea, authorized by share token instead of a session. */
export async function downloadSharedFile(options: SharedDownloadOptions & { signal?: AbortSignal }): Promise<DownloadResult> {
  emitDownloadStarted({ fileName: options.fileName, bytes: 0 });

  const useShare = options.shareId && options.shareToken;
  const fetchFn = useShare
    ? (blobId: string, signal?: AbortSignal) => fetchBlobBodyShared(blobId, options.shareId!, options.shareToken!, signal)
    : (blobId: string, signal?: AbortSignal) => fetchBlobBody(blobId, signal);

  // Shared downloads only know the manifestBlobId (which, post-E2EE, is
  // really just "the file's primary blob id" — chunk enumeration for shares
  // happens server-side via the share access response in future work; for
  // now a share exposes a single blob).
  const body = await fetchFn(options.manifestBlobId, options.signal);
  const chunks = [body];

  saveBlob(chunks, options.fileName, options.mimeType);
  return {
    fileName: options.fileName,
    bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  };
}

async function listChunkBlobIds(fileId: string): Promise<string[]> {
  const { uploadStatus } = await gqlRequest<{
    uploadStatus: { chunkCount: number; uploadedChunkIndices: number[] };
  }>(
    `query UploadStatus($fileId: ID!) { uploadStatus(fileId: $fileId) { chunkCount uploadedChunkIndices } }`,
    { fileId },
  );
  const count = uploadStatus.chunkCount;
  return Array.from({ length: count }, (_, i) => `${fileId}:chunk:${i}`);
}

async function downloadChunksConcurrently(
  blobIds: string[],
  fetchFn: (blobId: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
  signal: AbortSignal,
  onProgress: (downloadedChunks: number, bytesDownloaded: number) => void,
): Promise<ArrayBuffer[]> {
  const count = blobIds.length;
  const chunks: ArrayBuffer[] = new Array(count);
  const DOWNLOAD_CONCURRENCY = 20;
  const CHUNK_TIMEOUT_MS = 60_000;
  const MAX_CHUNK_RETRIES = 2;
  let downloadedBytes = 0;
  let downloadedChunks = 0;

  const fetchChunkWithTimeout = async (blobId: string): Promise<ArrayBuffer> => {
    for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("Download aborted", "AbortError");
      const timeoutSignal = AbortSignal.timeout(CHUNK_TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeoutSignal]);
      try {
        return await fetchFn(blobId, combined);
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (isTimeout && !signal.aborted && attempt < MAX_CHUNK_RETRIES) continue;
        throw err;
      }
    }
    throw new Error(`Chunk ${blobId} failed after ${MAX_CHUNK_RETRIES} retries`);
  };

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= count) break;
      const body = await fetchChunkWithTimeout(blobIds[i]!);
      chunks[i] = body;
      downloadedBytes += body.byteLength;
      downloadedChunks += 1;
      onProgress(downloadedChunks, downloadedBytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, count) }, worker));
  return chunks;
}

// === Folder ZIP download ===

const FOLDER_TREE_QUERY = `
  query FolderTree($parentFolderId: ID) {
    files(parentFolderId: $parentFolderId) {
      id name mimeType chunkCount status
    }
    folders(parentFolderId: $parentFolderId) {
      id name
    }
  }
`;

interface FolderTreeFile {
  id: string;
  name: string | null;
  mimeType: string | null;
  chunkCount: number;
  status: string;
}

interface FolderTreeFolder {
  id: string;
  name: string;
}

async function collectZipEntries(
  parentFolderId: string | null,
  pathPrefix: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  const result = await gqlRequest<{ files: FolderTreeFile[]; folders: FolderTreeFolder[] }>(
    FOLDER_TREE_QUERY,
    { parentFolderId },
  );

  for (const file of result.files.filter((f) => f.status === "READY")) {
    const fileName = file.name ?? file.id;
    try {
      const chunkBlobIds = await listChunkBlobIds(file.id);
      const chunkBuffers = await Promise.all(chunkBlobIds.map((id) => fetchBlobBody(id)));
      const totalBytes = chunkBuffers.reduce((sum, b) => sum + b.byteLength, 0);
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const buf of chunkBuffers) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }

      const zipPath = pathPrefix ? `${pathPrefix}/${fileName}` : fileName;
      entries[zipPath] = combined;
    } catch {
      // skip files that fail to download
    }
  }

  for (const folder of result.folders) {
    const subPath = pathPrefix ? `${pathPrefix}/${folder.name}` : folder.name;
    await collectZipEntries(folder.id, subPath, entries);
  }
}

export async function downloadFolderAsZip(
  folderId: string,
  folderName: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  onProgress?.("Collecting files…");
  const entries: Record<string, Uint8Array> = {};
  await collectZipEntries(folderId, "", entries);

  if (Object.keys(entries).length === 0) {
    throw new Error("Folder is empty");
  }

  onProgress?.(`Packing ${Object.keys(entries).length} files…`);
  const zipped = zipSync(entries, { level: 0 });

  const blob = new Blob([zipped], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function saveBlob(chunks: ArrayBuffer[], fileName: string, mimeType: string) {
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.info("[ddv4] download-started", { fileName, bytes: blob.size });
  (window as unknown as { __ddv4DownloadSignal?: { fileName: string; bytes: number } }).__ddv4DownloadSignal = {
    fileName,
    bytes: blob.size,
  };
}
