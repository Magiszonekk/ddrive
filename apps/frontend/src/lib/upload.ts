// ddrive — Upload pipeline
//
// Chunks are sent as plaintext over HTTPS; the API encrypts them before they
// ever reach a storage provider (see apps/api/src/storage/server-crypto.ts).
// No client-side crypto here anymore — see docs/hermes/concept.md.

import { chunkFileStream } from "@ddv4/processing";
import { UploadStatus } from "@ddv4/types";
import type { UploadedBlobTransportInput } from "@ddv4/types/api";
import { gqlRequest } from "./graphql.js";
import { uploadBlobToApi, BlobUploadError } from "./api.js";
import { LEGACY_UPLOAD_CHUNK_SIZE_BYTES } from "./upload-constants.js";
import { config } from "@ddv4/config";
import { useUploadStore } from "../stores/upload.js";
import { useAuthStore } from "../stores/auth.js";

interface UploadTelemetryEvent {
  type: string;
  [key: string]: unknown;
}

function isUploadDebugEnabled(): boolean {
  try {
    return localStorage.getItem("uploadDebug") === "1";
  } catch {
    return false;
  }
}

function logUploadEvent(event: UploadTelemetryEvent): void {
  if (!isUploadDebugEnabled()) return;
  console.debug("[upload-debug]", {
    ts: new Date().toISOString(),
    ...event,
  });
}

const CHUNK_MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const CHUNK_RETRY_BASE_MS = 800;

// Whole-pipeline restarts, on top of the per-chunk retries above. These cover
// failures the per-chunk budget cannot absorb — a network switch (wifi → LTE)
// or an API restart mid-transfer — by re-running the chunk phase against the
// chunks the server confirms it is still missing.
const RESUME_MAX_ATTEMPTS = 3;
const RESUME_BASE_DELAY_MS = 2000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Upload aborted", "AbortError"));
    }, { once: true });
  });
}

/** Definitive failures — retrying cannot help (bad request, expired session). */
function isDefinitiveFailure(err: unknown): boolean {
  return err instanceof BlobUploadError && err.status >= 400 && err.status < 500;
}

async function withChunkRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
      if (isDefinitiveFailure(err)) throw err;
      if (attempt === CHUNK_MAX_ATTEMPTS - 1) throw err;
      const delay = CHUNK_RETRY_BASE_MS * Math.pow(2, attempt); // 800ms, 1.6s, 3.2s
      await abortableDelay(delay, signal);
    }
  }
  throw new Error("Unreachable");
}

const INIT_UPLOAD = `
  mutation InitUpload(
    $parentFolderId: ID
    $name: String
    $mimeType: String
    $totalBytes: String!
    $chunkCount: Int!
  ) {
    initUpload(
      parentFolderId: $parentFolderId
      name: $name
      mimeType: $mimeType
      totalBytes: $totalBytes
      chunkCount: $chunkCount
    ) { fileId status }
  }
`;

const COMMIT_MANIFEST = `
  mutation CommitManifest(
    $fileId: ID!
    $manifestBlobId: String!
    $totalBytes: String!
    $chunkCount: Int!
    $blobs: [UploadedBlobTransportInput!]!
  ) {
    commitManifest(
      fileId: $fileId
      manifestBlobId: $manifestBlobId
      totalBytes: $totalBytes
      chunkCount: $chunkCount
      blobs: $blobs
    ) { success }
  }
`;

// Which chunks of an in-flight upload the server already holds. Authoritative
// where the client is not: a chunk whose response was lost in transit is on
// storage even though this client never saw the ack.
const UPLOAD_STATUS = `
  query UploadStatus($fileId: ID!) {
    uploadStatus(fileId: $fileId) {
      status
      uploadedChunkIndices
      hasManifest
    }
  }
`;

interface UploadStatusResult {
  status: string;
  uploadedChunkIndices: number[];
  hasManifest: boolean;
}

export async function uploadFile(file: File, folderId: string | null): Promise<string> {
  const authState = useAuthStore.getState();
  const authToken = authState.token;

  if (!authToken) {
    throw new Error("Session expired or missing API auth token. Log in again.");
  }

  const store = useUploadStore.getState();
  const uploadId = crypto.randomUUID();
  const placeholderId = `pending:${uploadId}`;
  const sessionStartMs = performance.now();

  // Chunk count computed from file size — no need to buffer the whole file first.
  const chunkCount = Math.ceil(file.size / LEGACY_UPLOAD_CHUNK_SIZE_BYTES);
  const totalBlobs = chunkCount + 1;

  logUploadEvent({
    type: "upload_session_started",
    uploadId,
    fileName: file.name,
    fileSize: file.size,
    folderId,
    chunkSize: LEGACY_UPLOAD_CHUNK_SIZE_BYTES,
    chunkCount,
    concurrency: config.defaultUploadConcurrency,
    mode: "streaming",
    tokenPresentAtStart: Boolean(authToken),
  });
  const controller = new AbortController();

  store.addUpload(placeholderId, totalBlobs, file.size, file.name);
  store.registerController(placeholderId, controller);
  store.updateUpload(placeholderId, { status: UploadStatus.UPLOADING });

  let activeUploadId = placeholderId;
  let uploadStartMs: number | null = null;

  try {
    const initUploadStartMs = performance.now();
    const { initUpload } = await gqlRequest<{ initUpload: { fileId: string; status: string } }>(INIT_UPLOAD, {
      parentFolderId: folderId,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      totalBytes: String(file.size),
      chunkCount,
    }, authToken);
    const initUploadMs = performance.now() - initUploadStartMs;

    logUploadEvent({
      type: "upload_init_timing",
      uploadId,
      fileName: file.name,
      fileSize: file.size,
      chunkCount: chunkCount,
      initUploadMs: Number(initUploadMs.toFixed(2)),
      preUploadWallMs: Number((performance.now() - sessionStartMs).toFixed(2)),
    });

    const realFileId = initUpload.fileId;
    store.removeUpload(placeholderId);
    activeUploadId = realFileId;
    store.addUpload(realFileId, totalBlobs, file.size, file.name);
    store.registerController(realFileId, controller);
    store.updateUpload(realFileId, { status: UploadStatus.UPLOADING });

    // Chunks safely on storage, keyed by index and carried across resume
    // attempts so a restart re-sends only what is genuinely missing.
    interface DoneChunk {
      index: number;
      plaintextBytes: number;
      blobRecord: UploadedBlobTransportInput | null;
    }
    const doneChunks = new Map<number, DoneChunk>();
    let serverHasChunks = new Set<number>();

    let uploadedBytes = 0;
    let uploadedBlobs = 0;

    const CONCURRENCY = config.defaultUploadConcurrency;
    uploadStartMs = performance.now();

    const uploadChunk = async (chunk: { index: number; data: Uint8Array }) => {
      if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
      if (doneChunks.has(chunk.index)) return;

      const chunkStartMs = performance.now();
      const chunkBuffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
      const blobId = `${realFileId}:chunk:${chunk.index}`;

      // Already on storage from an earlier attempt: no need to re-send bytes.
      const alreadyStored = serverHasChunks.has(chunk.index);
      let requestMs = 0;
      let blobRecord: UploadedBlobTransportInput | null = null;

      if (!alreadyStored) {
        const requestStartMs = performance.now();
        const uploadResult = await withChunkRetry(
          () => uploadBlobToApi(blobId, chunkBuffer, {
            authToken,
            extraHeaders: {
              "X-Upload-Id": uploadId,
              "X-Chunk-Index": String(chunk.index),
              "X-Chunk-Count": String(chunkCount),
              "X-Client-Timestamp": new Date().toISOString(),
            },
          }),
          controller.signal,
        );
        requestMs = performance.now() - requestStartMs;
        blobRecord = {
          blobId: uploadResult.blobId,
          sizeBytes: uploadResult.sizeBytes,
          contentHash: uploadResult.contentHash,
          storageKind: uploadResult.storageKind,
          storagePath: uploadResult.storagePath,
          discordMessageId: uploadResult.discordMessageId,
          discordChannelId: uploadResult.discordChannelId,
          webhookId: uploadResult.webhookId,
        };
      }

      doneChunks.set(chunk.index, {
        index: chunk.index,
        plaintextBytes: chunk.data.byteLength,
        blobRecord,
      });

      uploadedBytes += chunk.data.byteLength;
      uploadedBlobs += 1;
      store.updateUpload(realFileId, { uploadedBlobs, bytesUploaded: uploadedBytes });

      logUploadEvent({
        type: "upload_chunk_timing",
        uploadId,
        fileId: realFileId,
        chunkIndex: chunk.index,
        chunkCount: chunkCount,
        plaintextBytes: chunk.data.byteLength,
        requestMs: Number(requestMs.toFixed(2)),
        skippedAlreadyStored: alreadyStored,
        totalChunkMs: Number((performance.now() - chunkStartMs).toFixed(2)),
      });
    };

    // One pass over the file. Workers share the streaming iterator through a
    // mutex; a resume starts a fresh pass, and chunks already in doneChunks
    // fall straight through.
    const runChunkPass = async () => {
      const chunkIter = chunkFileStream(file, LEGACY_UPLOAD_CHUNK_SIZE_BYTES)[Symbol.asyncIterator]();
      let iterLocked = false;
      const iterWaiters: Array<() => void> = [];
      const nextChunk = async (): Promise<{ index: number; data: Uint8Array } | null> => {
        while (iterLocked) {
          await new Promise<void>(resolve => iterWaiters.push(resolve));
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

      const worker = async () => {
        while (true) {
          if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
          const chunk = await nextChunk();
          if (!chunk) break;
          await uploadChunk(chunk);
        }
      };

      // allSettled, not all: a rejection from one worker leaves the others
      // running, and a resume must not start a second pass over the same file
      // while stragglers from the failed one are still uploading. Waiting for
      // every worker to settle also lets the survivors land more chunks first.
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(CONCURRENCY, chunkCount) }, () => worker()),
      );
      const failure = results.find((r) => r.status === "rejected");
      if (failure) throw (failure as PromiseRejectedResult).reason;
    };

    for (let attempt = 1; ; attempt++) {
      try {
        await runChunkPass();
        break;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (isDefinitiveFailure(error)) throw error;
        if (attempt >= RESUME_MAX_ATTEMPTS) throw error;

        // Reconcile with the server before retrying: chunks whose ack was lost
        // in transit are on storage already and must not be sent twice.
        try {
          const { uploadStatus } = await gqlRequest<{ uploadStatus: UploadStatusResult }>(
            UPLOAD_STATUS, { fileId: realFileId }, authToken,
          );
          serverHasChunks = new Set(uploadStatus.uploadedChunkIndices);
        } catch {
          // Best effort — without it we simply resume from local state.
        }

        logUploadEvent({
          type: "upload_resume_attempt",
          uploadId,
          fileId: realFileId,
          attempt,
          chunksConfirmedLocally: doneChunks.size,
          chunksOnServer: serverHasChunks.size,
          error: error instanceof Error ? error.message : String(error),
        });

        await abortableDelay(RESUME_BASE_DELAY_MS * Math.pow(2, attempt - 1), controller.signal);
      }
    }

    const doneInOrder = Array.from(doneChunks.values()).sort((a, b) => a.index - b.index);
    const uploadedBlobRecords: UploadedBlobTransportInput[] = doneInOrder
      .map((c) => c.blobRecord)
      .filter((record): record is UploadedBlobTransportInput => record !== null);

    store.updateUpload(realFileId, { status: UploadStatus.COMMITTING_MANIFEST });

    // "Manifest" concept simplified post-E2EE: the last uploaded chunk's
    // blobId doubles as the manifest reference (chunk enumeration now comes
    // from uploadStatus/chunkCount, not an encrypted manifest blob).
    const manifestBlobId = `${realFileId}:chunk:${chunkCount - 1}`;

    const commitManifestStartMs = performance.now();
    // The one call that turns an UPLOADING row into a READY file, so a blip here
    // would waste the whole transfer. Retried — and if the retries still fail the
    // server is asked directly, because a commit whose response was lost in
    // transit did land: the file is READY even though this client saw an error.
    let commitSucceeded: boolean;
    try {
      const { commitManifest } = await withChunkRetry(
        () => gqlRequest<{ commitManifest: { success: boolean } }>(COMMIT_MANIFEST, {
          fileId: realFileId,
          manifestBlobId,
          totalBytes: String(file.size),
          chunkCount: chunkCount,
          blobs: uploadedBlobRecords,
        }, authToken),
        controller.signal,
      );
      commitSucceeded = commitManifest.success;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const { uploadStatus } = await gqlRequest<{ uploadStatus: UploadStatusResult }>(
        UPLOAD_STATUS, { fileId: realFileId }, authToken,
      );
      if (uploadStatus.status !== "READY") throw error;
      commitSucceeded = true;
      logUploadEvent({
        type: "upload_commit_recovered",
        uploadId,
        fileId: realFileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const commitManifestMs = performance.now() - commitManifestStartMs;

    logUploadEvent({
      type: "upload_commit_manifest_timing",
      uploadId,
      fileId: realFileId,
      manifestBlobId,
      chunkCount: chunkCount,
      blobRecordCount: uploadedBlobRecords.length,
      commitManifestMs: Number(commitManifestMs.toFixed(2)),
      elapsedUploadWallMs: Number((performance.now() - uploadStartMs).toFixed(2)),
    });

    if (!commitSucceeded) {
      store.updateUpload(realFileId, { status: UploadStatus.FAILED });
      logUploadEvent({
        type: "upload_session_failed",
        uploadId,
        fileId: realFileId,
        stage: "commit_manifest",
        elapsedMs: Number((performance.now() - uploadStartMs).toFixed(2)),
        error: "Manifest commit failed",
      });
      throw new Error("Manifest commit failed");
    }

    const totalDurationMs = performance.now() - uploadStartMs;
    const totalWallMs = performance.now() - sessionStartMs;
    logUploadEvent({
      type: "upload_session_completed",
      uploadId,
      fileId: realFileId,
      fileName: file.name,
      fileSize: file.size,
      chunkCount,
      totalDurationMs: Number(totalDurationMs.toFixed(2)),
      totalWallMs: Number(totalWallMs.toFixed(2)),
      throughputMBps: Number((file.size / 1024 / 1024 / (totalDurationMs / 1000)).toFixed(2)),
    });

    store.updateUpload(realFileId, { status: UploadStatus.DONE });
    return realFileId;
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
    store.updateUpload(activeUploadId, { status: UploadStatus.FAILED });
    throw error;
  }
}
