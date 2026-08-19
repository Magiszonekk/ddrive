// ddrive — HTTP API client
//
// Chunks now travel as plaintext over HTTPS between browser and API; the
// server encrypts before it ever reaches a storage provider (see
// apps/api/src/storage/server-crypto.ts). No client-side crypto here anymore.

import { useAuthStore } from "../stores/auth.js";

const API_BASE = "";

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface BlobUploadResponse {
  blobId: string;
  sizeBytes: string;
  contentHash?: string;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}

export interface BlobUploadRequestOptions {
  extraHeaders?: Record<string, string>;
  authToken?: string;
}

export class BlobUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BlobUploadError";
  }
}

function toUploadBody(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  return data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function uploadBlobToApi(
  blobId: string,
  data: ArrayBuffer | Uint8Array,
  options: BlobUploadRequestOptions = {},
): Promise<BlobUploadResponse> {
  const authHeaders = options.authToken
    ? { Authorization: `Bearer ${options.authToken}` }
    : getAuthHeaders();

  const response = await fetch(`${API_BASE}/api/blob/${blobId}`, {
    method: "PUT",
    headers: {
      ...authHeaders,
      "Content-Type": "application/octet-stream",
      ...(options.extraHeaders ?? {}),
    },
    body: toUploadBody(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Blob upload failed" }));
    throw new BlobUploadError((error as { error: string }).error, response.status);
  }

  return response.json() as Promise<BlobUploadResponse>;
}

/** Anonymous chunk upload (Phase 6) — no auth header, gated by fileId ownership server-side. */
export async function uploadAnonymousBlobToApi(
  blobId: string,
  data: ArrayBuffer | Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<BlobUploadResponse> {
  const response = await fetch(`${API_BASE}/api/anon-blob/${blobId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      ...extraHeaders,
    },
    body: toUploadBody(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Blob upload failed" }));
    throw new BlobUploadError((error as { error: string }).error, response.status);
  }

  return response.json() as Promise<BlobUploadResponse>;
}

export async function fetchBlobDescriptor(blobId: string): Promise<{
  blobId: string;
  sizeBytes: string;
  contentHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}> {
  const response = await fetch(`${API_BASE}/api/blob/${blobId}/meta`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Blob metadata fetch failed: ${response.status}`);
  }

  return response.json() as Promise<{
    blobId: string;
    sizeBytes: string;
    contentHash?: string;
    discordMessageId?: string;
    discordChannelId?: string;
    webhookId?: string;
  }>;
}

/** Fetches a blob's already-decrypted plaintext bytes (server decrypts).
 *  Pass anonSessionId for anonymous-upload blobs (no auth token). */
export async function fetchBlobBody(
  blobId: string,
  signal?: AbortSignal,
  anonSessionId?: string,
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = getAuthHeaders();
  if (anonSessionId) headers["X-Anon-Session-Id"] = anonSessionId;

  const response = await fetch(`${API_BASE}/api/blob/${blobId}`, {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Blob body fetch failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

/** Fetches a blob's plaintext bytes through the no-auth share route. */
export async function fetchBlobBodyShared(
  blobId: string,
  shareId: string,
  shareToken: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${API_BASE}/api/share/blob/${blobId}`, {
    headers: {
      "X-Share-Id": shareId,
      "X-Share-Token": shareToken,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Blob body fetch failed: ${response.status}`);
  }

  return response.arrayBuffer();
}
