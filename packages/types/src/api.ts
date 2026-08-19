// ddrive v4 — API request/response types

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    username: string | null;
  };
  refreshToken?: string;
}

export interface InitUploadRequest {
  parentFolderId?: string;
  name?: string;
  mimeType?: string;
  totalBytes: string;
  chunkCount: number;
}

export interface InitUploadResponse {
  fileId: string;
  status: "uploading";
}

export interface UploadedBlobTransportInput {
  blobId: string;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  sizeBytes: string;
  contentHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}

export interface CommitManifestRequest {
  fileId: string;
  manifestBlobId: string;
  totalBytes: string;
  chunkCount: number;
  blobs: UploadedBlobTransportInput[];
}

export interface FinalizeUploadResponse {
  success: boolean;
}

export interface CreateFileShareRequest {
  fileId: string;
  allowContent: boolean;
  allowPreview: boolean;
  expiresAt?: string;
  maxViews?: number;
}

export interface SharedFolderItem {
  id: string;
  name: string | null;
  mimeType: string | null;
  size: string;
  thumbnailBlobId: string | null;
  chunkCount: number;
  kind: "FILE" | "FOLDER";
}

export interface ShareAccessResponse {
  shareId: string;
  shareType: "FILE" | "FOLDER";
  fileId: string;
  folderId: string | null;
  name: string | null;
  mimeType: string | null;
  primaryManifestBlobId: string | null;
  previewBlobId: string | null;
  thumbnailBlobId: string | null;
  posterBlobId: string | null;
  chunkCount: number;
  allowContent: boolean;
  allowPreview: boolean;
  folderContents?: SharedFolderItem[];
}

export type BlobStorageKindDto = "LOCAL" | "DISCORD" | "TELEGRAM";

export interface BlobTransportMetadataDto {
  blobId: string;
  ownerUserId: string;
  storageKind: BlobStorageKindDto;
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
  sizeBytes: string;
  contentHash?: string;
  healthStatus?: "healthy" | "missing" | "modified";
  healthCheckedAt?: string;
  createdAt: string;
}

export interface BlobFetchAuthorizationResponse {
  blobId: string;
  storageKind: BlobStorageKindDto;
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
  sizeBytes: string;
  contentHash?: string;
}
