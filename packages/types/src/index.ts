// ddrive v4 — Domain types

export enum UploadStatus {
  PENDING = "PENDING",
  UPLOADING = "UPLOADING",
  COMMITTING_MANIFEST = "COMMITTING_MANIFEST",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum DownloadStatus {
  DOWNLOADING = "DOWNLOADING",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum FileStatus {
  UPLOADING = "UPLOADING",
  READY = "READY",
  FAILED = "FAILED",
}

export enum ShareStatus {
  ACTIVE = "ACTIVE",
  REVOKED = "REVOKED",
  EXPIRED = "EXPIRED",
}

export type ShareType = "file";
export type AppMode = "full" | "backend-only";

export interface FileRecord {
  id: string;
  ownerUserId: string;
  parentFolderId: string | null;
  name: string | null;
  mimeType: string | null;
  primaryManifestBlobId: string | null;
  previewBlobId: string | null;
  thumbnailBlobId: string | null;
  posterBlobId: string | null;
  status: FileStatus;
  totalBytes: bigint;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FolderRecord {
  id: string;
  ownerUserId: string;
  parentFolderId: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export type BlobStorageKind = "LOCAL";

export interface BlobTransportRecord {
  blobId: string;
  ownerUserId: string;
  storageKind: BlobStorageKind;
  storagePath: string;
  sizeBytes: bigint;
  contentHash: string | null;
  healthStatus: "healthy" | "missing" | "modified" | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
}

export interface TimestampedTag {
  tag: string;
  at: string;
}

export interface ProviderInfo {
  mode: "local" | "hybrid" | "external";
  providerName?: string;
  providerVersion?: string;
  modelName?: string;
  analyzedAt: string;
}

export interface FileMetadataPlaintext {
  schemaVersion: number;
  fileName: string;
  mimeType: string;
  plaintextSizeBytes: number;
  capturedAt?: string;
  description?: string;
  tags: TimestampedTag[];
  removedTags: TimestampedTag[];
  favorite: boolean;
  hidden: boolean;
  provider?: ProviderInfo;
  scalarLWW: Partial<Record<FileScalarLWWKey, string>>;
}

export type FileScalarLWWKey =
  | "fileName"
  | "mimeType"
  | "plaintextSizeBytes"
  | "capturedAt"
  | "description"
  | "favorite"
  | "hidden"
  | "provider";

export interface FileChunkPointer {
  index: number;
  blobId: string;
  sizeBytes: number;
  contentHash?: string;
}

export interface FileChunkManifestPlaintext {
  schemaVersion: number;
  chunkSizeBytes: number;
  chunks: FileChunkPointer[];
}

export interface ShareRecord {
  shareId: string;
  ownerUserId: string;
  fileId: string;
  shareType: ShareType;
  tokenHash: string;
  allowContent: boolean;
  allowPreview: boolean;
  status: ShareStatus;
  expiresAt?: Date | null;
  maxViews?: number | null;
  viewCount: number;
  createdAt: Date;
  revokedAt?: Date | null;
}

export interface UploadProgress {
  fileId: string;
  fileName?: string;
  totalBlobs: number;
  uploadedBlobs: number;
  bytesUploaded: number;
  bytesTotal: number;
  status: UploadStatus;
  speedBps?: number;
}

export interface DownloadProgress {
  fileId: string;
  totalBlobs: number;
  downloadedBlobs: number;
  bytesDownloaded: number;
  bytesTotal: number;
}
