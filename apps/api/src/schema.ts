// ddrive v4 — GraphQL Schema

import { createSchema } from "graphql-yoga";
import { resolveRequestAuth, isBackendOnly, type ResolvedAuth } from "./middleware/auth.js";
import { enforceRateLimit } from "./middleware/rate-limit.js";
import * as authResolvers from "./resolvers/auth.js";
import * as fileResolvers from "./resolvers/files.js";
import * as folderResolvers from "./resolvers/folders.js";
import * as sharingResolvers from "./resolvers/sharing.js";
import { pluginRegistry } from "./plugin-registry.js";

export interface Context {
  auth: ResolvedAuth | null;
  ip: string;
}

function requireAuth(ctx: Context): ResolvedAuth {
  if (!ctx.auth) throw new Error("Authentication required");
  return ctx.auth;
}

function requireFullMode(): void {
  if (isBackendOnly()) throw new Error("Not available in backend-only mode");
}

function requireInteractive(ctx: Context): ResolvedAuth {
  const auth = requireAuth(ctx);
  if (auth.via !== "jwt") {
    throw new Error("Not available to API keys — sign in from the web app for this operation");
  }
  return auth;
}

function mergeResolvers(
  ...maps: Record<string, unknown>[]
): Parameters<typeof createSchema<Context>>[0]["resolvers"] {
  return maps.reduce(
    (acc, cur) => {
      for (const [k, v] of Object.entries(cur)) {
        acc[k] =
          v !== null && typeof v === "object" && !Array.isArray(v) && typeof acc[k] === "object" && acc[k] !== null
            ? { ...(acc[k] as object), ...(v as object) }
            : v;
      }
      return acc;
    },
    {} as Record<string, unknown>,
  ) as Parameters<typeof createSchema<Context>>[0]["resolvers"];
}

export function buildSchema() {
  const { typeDefs: pluginTypeDefs, resolvers: pluginResolvers } = pluginRegistry.getGraphqlExtensions();

  return createSchema<Context>({
    typeDefs: [/* GraphQL */ `
      scalar DateTime
      scalar Float

      type User {
        id: ID!
        email: String!
        username: String
      }

      type AuthResponse {
        token: String!
        refreshToken: String
        user: User!
      }

      type DeviceSession {
        id: ID!
        deviceName: String
        createdAt: DateTime!
        lastUsedAt: DateTime!
        expiresAt: DateTime!
      }

      type RefreshSessionResult {
        token: String!
      }

      type ApiKey {
        id: ID!
        name: String!
        prefix: String!
        createdAt: DateTime!
        lastUsedAt: DateTime
        expiresAt: DateTime
      }

      type File {
        id: ID!
        parentFolderId: ID
        name: String
        mimeType: String
        primaryManifestBlobId: String
        previewBlobId: String
        thumbnailBlobId: String
        posterBlobId: String
        status: String!
        totalBytes: String!
        chunkCount: Int!
        createdAt: DateTime!
        updatedAt: DateTime!
        deletedAt: DateTime
      }

      type Folder {
        id: ID!
        parentFolderId: ID
        name: String!
        itemCount: Int!
        totalSizeBytes: String!
        createdAt: DateTime!
        updatedAt: DateTime!
      }

      type AnonymousFile {
        id: ID!
        kind: String! # "FILE" | "FOLDER"
        name: String
        mimeType: String
        thumbnailBlobId: String
        totalBytes: String!
        itemCount: Int
        status: String!
        parentFolderId: ID
        expiresAt: DateTime
        createdAt: DateTime!
      }

      type ShareAccess {
        shareId: ID!
        shareType: String!
        fileId: ID!
        folderId: ID
        name: String
        mimeType: String
        primaryManifestBlobId: String
        previewBlobId: String
        thumbnailBlobId: String
        posterBlobId: String
        chunkCount: Int!
        allowContent: Boolean!
        allowPreview: Boolean!
        folderContents: [SharedFolderItem!]
      }

      type SharedFolderItem {
        id: ID!
        name: String
        mimeType: String
        size: String!
        thumbnailBlobId: String
        chunkCount: Int!
        kind: String!
      }

      type ShareInfo {
        shareId: ID!
        shareType: String!
        fileId: ID!
        allowContent: Boolean!
        allowPreview: Boolean!
        status: String!
        expiresAt: DateTime
        maxViews: Int
        viewCount: Int!
        createdAt: DateTime!
      }

      type ShareCreateResult {
        shareId: ID!
        token: String!
      }

      type InitUploadResult {
        fileId: ID!
        status: String!
      }

      type CommitManifestResult {
        success: Boolean!
      }

      type UploadStatus {
        fileId: ID!
        status: String!
        chunkCount: Int!
        uploadedChunkIndices: [Int!]!
        hasManifest: Boolean!
      }

      input UploadedBlobTransportInput {
        blobId: String!
        storageKind: String!
        storagePath: String!
        sizeBytes: String!
        contentHash: String
        discordMessageId: String
        discordChannelId: String
        webhookId: String
      }

      type StorageUsage {
        totalBytes: String!
        fileCount: Int!
      }

      type HealthCheckChunk {
        id: ID!
        index: Int!
        messageId: String!
        webhookId: String!
        size: Int!
        contentHash: String
        healthStatus: String
        healthCheckedAt: DateTime
      }

      type HealthCheckFile {
        fileId: ID!
        fileName: String!
        chunkCount: Int!
        chunks: [HealthCheckChunk!]!
      }

      type HealthCheckSummary {
        checked: Int!
        healthy: Int!
        missing: Int!
        modified: Int!
        skipped: Int!
        durationMs: Int!
      }

      input ChunkHealthUpdateInput {
        chunkId: ID!
        status: String!
      }

      type ReplicationPlacementGroup {
        provider: String!
        poolRole: String!
        status: String!
        count: Int!
      }

      type ReplicationStatus {
        enabled: Boolean!
        replicaProviders: [String!]!
        queueDepth: Int!
        oldestQueuedAgeSeconds: Int
        failedPlacements: Int!
        placements: [ReplicationPlacementGroup!]!
      }

      type Query {
        me: User
        files(parentFolderId: ID): [File!]!
        folders(parentFolderId: ID): [Folder!]!
        folderPath(folderId: ID!): [Folder!]!
        file(fileId: ID!): File
        trashedFiles: [File!]!
        sessions: [DeviceSession!]!
        apiKeys: [ApiKey!]!
        uploadStatus(fileId: ID!): UploadStatus!
        shares(fileId: ID!): [ShareInfo!]!
        storageUsage: StorageUsage!
        accessShare(shareId: ID!, token: String!): ShareAccess
        myAnonymousUploads(anonSessionId: String!): [AnonymousFile!]!
        anonymousFiles(anonSessionId: String!, parentFolderId: ID): [AnonymousFile!]!
        anonymousFolderPath(anonSessionId: String!, folderId: ID!): [AnonymousFile!]!
        filesForHealthCheck(samplePercent: Float, fileId: ID): [HealthCheckFile!]!
        replicationStatus: ReplicationStatus!
      }

      type Mutation {
        register(
          email: String!
          username: String!
          password: String!
        ): AuthResponse!

        login(emailOrUsername: String!, password: String!, deviceName: String): AuthResponse!

        refreshSession(refreshToken: String!): RefreshSessionResult!
        revokeSession(sessionId: ID!): Boolean!

        createApiKey(
          name: String!
          authPart: String!
          expiresAt: String
        ): ApiKey!
        revokeApiKey(apiKeyId: ID!): Boolean!

        changePassword(
          currentPassword: String!
          newPassword: String!
        ): Boolean!

        initUpload(
          parentFolderId: ID
          name: String
          mimeType: String
          totalBytes: String!
          chunkCount: Int!
        ): InitUploadResult!

        initAnonymousUpload(
          name: String
          mimeType: String
          totalBytes: String!
          chunkCount: Int!
          anonSessionId: String
          parentFolderId: ID
        ): InitUploadResult!

        commitAnonymousManifest(
          fileId: ID!
          manifestBlobId: String!
          totalBytes: String!
          chunkCount: Int!
          blobs: [UploadedBlobTransportInput!]!
          parentFolderId: ID
        ): CommitManifestResult!

        setFilePreview(fileId: ID!, previewBlobId: String!): Boolean!

        commitManifest(
          fileId: ID!
          manifestBlobId: String!
          totalBytes: String!
          chunkCount: Int!
          blobs: [UploadedBlobTransportInput!]!
        ): CommitManifestResult!

        deleteFile(fileId: ID!): Boolean!
        moveFile(fileId: ID!, parentFolderId: ID): Boolean!
        restoreFile(fileId: ID!): Boolean!
        purgeFile(fileId: ID!): Boolean!
        emptyTrash: Int!

        createFolder(name: String!, parentFolderId: ID): Folder!
        renameFolder(folderId: ID!, name: String!): Boolean!
        moveFolder(folderId: ID!, parentFolderId: ID): Boolean!
        deleteFolder(folderId: ID!): Boolean!

        createShare(
          fileId: ID!
          allowContent: Boolean!
          allowPreview: Boolean
          expiresAt: String
          maxViews: Int
        ): ShareCreateResult!

        revokeShare(shareId: ID!): Boolean!
        createAnonymousShare(fileId: ID!, allowContent: Boolean!, allowPreview: Boolean): ShareCreateResult!
        createAnonymousFolderShare(folderId: ID!, allowContent: Boolean!, allowPreview: Boolean): ShareCreateResult!
        reportShare(shareId: ID!, reason: String!, note: String): Boolean!
        claimShare(shareId: ID!, token: String!): Boolean!
        # Anonymous workspace (Phase 8) — no auth; scoped by anonSessionId.
        createAnonymousFolder(name: String!, parentFolderId: ID, anonSessionId: String!): AnonymousFile!
        renameAnonymousFolder(folderId: ID!, name: String!, anonSessionId: String!): Boolean!
        deleteAnonymousFolder(folderId: ID!, anonSessionId: String!): Boolean!
        moveAnonymousFolder(folderId: ID!, parentFolderId: ID, anonSessionId: String!): Boolean!
        moveAnonymousFile(fileId: ID!, parentFolderId: ID, anonSessionId: String!): Boolean!
        extendAnonymousTTL(fileId: ID!, anonSessionId: String!): Boolean!
        deleteAnonymousFile(fileId: ID!, anonSessionId: String!): Boolean!
        updateChunkHealthBatch(updates: [ChunkHealthUpdateInput!]!): Boolean!
        runHealthCheck(mode: String!, samplePercent: Float, fileId: ID): HealthCheckSummary!
      }
    `, ...pluginTypeDefs],
    resolvers: mergeResolvers({
      DateTime: {
        serialize: (value: unknown) => (value instanceof Date ? value.toISOString() : value),
        parseValue: (value: unknown) => new Date(value as string),
      },
      File: {
        totalBytes: (parent: { totalBytes: bigint | string }) => parent.totalBytes.toString(),
      },
      Folder: {
        totalSizeBytes: (parent: { totalSizeBytes?: string }) => parent.totalSizeBytes ?? "0",
      },
      Query: {
        me: async (_parent: unknown, _args: unknown, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          const { db } = await import("@ddv4/database");
          const user = await db.user.findUnique({ where: { id: auth.userId } });
          if (!user) return null;
          return {
            id: user.id,
            email: user.email,
            username: user.username,
          };
        },
        files: async (_parent: unknown, args: { parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFiles(auth.userId, args.parentFolderId ?? null);
        },
        folders: async (_parent: unknown, args: { parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.getFolders(auth.userId, args.parentFolderId ?? null);
        },
        folderPath: async (_parent: unknown, args: { folderId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.getFolderPath(auth.userId, args.folderId);
        },
        file: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFile(auth.userId, args.fileId);
        },
        uploadStatus: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getUploadStatus(auth.userId, args.fileId);
        },
        trashedFiles: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getTrashedFiles(auth.userId);
        },
        sessions: async (_parent: unknown, _args: unknown, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          return authResolvers.listSessions(auth.userId);
        },
        apiKeys: async (_parent: unknown, _args: unknown, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          return authResolvers.listApiKeys(auth.userId);
        },
        shares: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.getShares(auth.userId, args.fileId);
        },
        storageUsage: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getStorageUsage(auth.userId);
        },
        filesForHealthCheck: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFilesForHealthCheckDisplay(auth.userId);
        },
        replicationStatus: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getReplicationStatus(auth.userId);
        },
        accessShare: async (_parent: unknown, args: { shareId: string; token: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return sharingResolvers.accessShare(args.shareId, args.token);
        },
        myAnonymousUploads: async (_parent: unknown, args: { anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.getAnonymousUploadsBySession(args.anonSessionId);
        },
        anonymousFiles: async (_parent: unknown, args: { anonSessionId: string; parentFolderId?: string | null }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          const [files, folders] = await Promise.all([
            fileResolvers.getAnonymousFiles(args.anonSessionId, args.parentFolderId ?? null),
            folderResolvers.getAnonymousFolders(args.anonSessionId, args.parentFolderId ?? null),
          ]);
          const fileItems = files.map((f) => ({
            id: f.id,
            kind: "FILE",
            name: f.name,
            mimeType: f.mimeType,
            thumbnailBlobId: f.thumbnailBlobId,
            totalBytes: f.totalBytes.toString(),
            itemCount: null,
            status: f.status,
            parentFolderId: f.parentFolderId,
            expiresAt: f.expiresAt,
            createdAt: f.createdAt,
          }));
          const folderItems = folders.map((f) => ({
            id: f.id,
            kind: "FOLDER",
            name: f.name,
            mimeType: null,
            thumbnailBlobId: null,
            totalBytes: f.totalSizeBytes,
            itemCount: f.itemCount,
            status: "READY",
            parentFolderId: f.parentFolderId,
            expiresAt: f.expiresAt,
            createdAt: f.createdAt,
          }));
          // Folders first, then files (both newest-first already from resolvers).
          return [...folderItems, ...fileItems];
        },
        anonymousFolderPath: async (_parent: unknown, args: { anonSessionId: string; folderId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          const folders = await folderResolvers.getAnonymousFolderPath(args.anonSessionId, args.folderId);
          return folders.map((f) => ({
            id: f.id,
            kind: "FOLDER",
            name: f.name,
            mimeType: null,
            thumbnailBlobId: null,
            totalBytes: f.totalSizeBytes,
            itemCount: f.itemCount,
            status: "READY",
            parentFolderId: f.parentFolderId,
            expiresAt: f.expiresAt,
            createdAt: f.createdAt,
          }));
        },
      },
      Mutation: {
        register: async (_parent: unknown, args: {
          email: string;
          username: string;
          password: string;
        }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.register(args);
        },
        login: async (_parent: unknown, args: { emailOrUsername: string; password: string; deviceName?: string }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.login(args.emailOrUsername, args.password, args.deviceName ?? null);
        },
        refreshSession: async (_parent: unknown, args: { refreshToken: string }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.refreshSession(args.refreshToken);
        },
        revokeSession: async (_parent: unknown, args: { sessionId: string }, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          return authResolvers.revokeSession(auth.userId, args.sessionId);
        },
        createApiKey: async (_parent: unknown, args: {
          name: string;
          authPart: string;
          expiresAt?: string;
        }, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          return authResolvers.createApiKey(auth.userId, args);
        },
        revokeApiKey: async (_parent: unknown, args: { apiKeyId: string }, ctx: Context) => {
          requireFullMode();
          const auth = requireInteractive(ctx);
          return authResolvers.revokeApiKey(auth.userId, args.apiKeyId);
        },
        changePassword: async (_parent: unknown, args: {
          currentPassword: string;
          newPassword: string;
        }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          const auth = requireInteractive(ctx);
          return authResolvers.changePassword(auth.userId, args.currentPassword, args.newPassword);
        },
        initUpload: async (_parent: unknown, args: {
          parentFolderId?: string;
          name?: string;
          mimeType?: string;
          totalBytes: string;
          chunkCount: number;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.initUpload(auth.userId, args);
        },
        initAnonymousUpload: async (_parent: unknown, args: {
          name?: string;
          mimeType?: string;
          totalBytes: string;
          chunkCount: number;
          anonSessionId?: string;
          parentFolderId?: string | null;
        }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.initAnonymousUpload(
            { name: args.name, mimeType: args.mimeType, totalBytes: args.totalBytes, chunkCount: args.chunkCount },
            args.anonSessionId ?? null,
            args.parentFolderId ?? null,
          );
        },
        commitAnonymousManifest: async (_parent: unknown, args: {
          fileId: string;
          manifestBlobId: string;
          totalBytes: string;
          chunkCount: number;
          blobs: Array<{
            blobId: string;
            storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
            storagePath: string;
            sizeBytes: string;
            contentHash?: string;
            discordMessageId?: string;
            discordChannelId?: string;
            webhookId?: string;
          }>;
          parentFolderId?: string | null;
        }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.commitAnonymousManifest(args.fileId, args.manifestBlobId, args.totalBytes, args.chunkCount, args.blobs, args.parentFolderId ?? null);
        },
        commitManifest: async (_parent: unknown, args: {
          fileId: string;
          manifestBlobId: string;
          totalBytes: string;
          chunkCount: number;
          blobs: Array<{
            blobId: string;
            storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
            storagePath: string;
            sizeBytes: string;
            contentHash?: string;
            discordMessageId?: string;
            discordChannelId?: string;
            webhookId?: string;
          }>;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.commitManifest(auth.userId, args.fileId, args.manifestBlobId, args.totalBytes, args.chunkCount, args.blobs);
        },
        deleteFile: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.deleteFile(auth.userId, args.fileId);
        },
        moveFile: async (_parent: unknown, args: { fileId: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.moveFile(auth.userId, args.fileId, args.parentFolderId ?? null);
        },
        setFilePreview: async (_parent: unknown, args: { fileId: string; previewBlobId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.setFilePreview(auth.userId, args.fileId, args.previewBlobId);
        },
        restoreFile: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.restoreFile(auth.userId, args.fileId);
        },
        purgeFile: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.purgeFile(auth.userId, args.fileId);
        },
        emptyTrash: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.emptyTrash(auth.userId);
        },
        createFolder: async (_parent: unknown, args: { name: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.createFolder(auth.userId, args.name, args.parentFolderId ?? null);
        },
        renameFolder: async (_parent: unknown, args: { folderId: string; name: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.renameFolder(auth.userId, args.folderId, args.name);
        },
        moveFolder: async (_parent: unknown, args: { folderId: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.moveFolder(auth.userId, args.folderId, args.parentFolderId ?? null);
        },
        deleteFolder: async (_parent: unknown, args: { folderId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.deleteFolder(auth.userId, args.folderId);
        },
        createShare: async (_parent: unknown, args: {
          fileId: string;
          allowContent: boolean;
          allowPreview?: boolean;
          expiresAt?: string;
          maxViews?: number;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.createShare(auth.userId, {
            ...args,
            allowPreview: args.allowPreview ?? false,
          });
        },
        updateChunkHealthBatch: async (_parent: unknown, args: { updates: Array<{ chunkId: string; status: string }> }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.updateChunkHealthBatch(auth.userId, args.updates as Array<{ chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" }>);
        },
        runHealthCheck: async (_parent: unknown, args: { mode: string; samplePercent?: number; fileId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.runHealthCheck(auth.userId, args.mode, args.samplePercent ?? null, args.fileId ?? null);
        },
        revokeShare: async (_parent: unknown, args: { shareId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.revokeShare(auth.userId, args.shareId);
        },
        createAnonymousShare: async (_parent: unknown, args: { fileId: string; allowContent: boolean; allowPreview?: boolean }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return sharingResolvers.createAnonymousShare(args.fileId, args.allowContent, args.allowPreview ?? false);
        },
        createAnonymousFolderShare: async (_parent: unknown, args: { folderId: string; allowContent: boolean; allowPreview?: boolean }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return sharingResolvers.createAnonymousFolderShare(args.folderId, args.allowContent, args.allowPreview ?? false);
        },
        reportShare: async (_parent: unknown, args: { shareId: string; reason: string; note?: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return sharingResolvers.reportShare(args.shareId, args.reason, args.note ?? null, ctx.ip);
        },
        claimShare: async (_parent: unknown, args: { shareId: string; token: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.claimShare(auth.userId, args.shareId, args.token);
        },
        createAnonymousFolder: async (_parent: unknown, args: { name: string; parentFolderId?: string | null; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          const folder = await folderResolvers.createAnonymousFolder(args.name, args.parentFolderId ?? null, args.anonSessionId);
          return {
            id: folder.id,
            kind: "FOLDER",
            name: folder.name,
            mimeType: null,
            thumbnailBlobId: null,
            totalBytes: folder.totalSizeBytes,
            itemCount: folder.itemCount,
            status: "READY",
            parentFolderId: folder.parentFolderId,
            expiresAt: folder.expiresAt,
            createdAt: folder.createdAt,
          };
        },
        renameAnonymousFolder: async (_parent: unknown, args: { folderId: string; name: string; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return folderResolvers.renameAnonymousFolder(args.folderId, args.name, args.anonSessionId);
        },
        deleteAnonymousFolder: async (_parent: unknown, args: { folderId: string; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return folderResolvers.deleteAnonymousFolder(args.folderId, args.anonSessionId);
        },
        moveAnonymousFolder: async (_parent: unknown, args: { folderId: string; parentFolderId?: string | null; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return folderResolvers.moveAnonymousFolder(args.folderId, args.parentFolderId ?? null, args.anonSessionId);
        },
        moveAnonymousFile: async (_parent: unknown, args: { fileId: string; parentFolderId?: string | null; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.moveAnonymousFile(args.fileId, args.parentFolderId ?? null, args.anonSessionId);
        },
        extendAnonymousTTL: async (_parent: unknown, args: { fileId: string; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.extendAnonymousTTL(args.fileId, args.anonSessionId);
        },
        deleteAnonymousFile: async (_parent: unknown, args: { fileId: string; anonSessionId: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return fileResolvers.deleteAnonymousFile(args.fileId, args.anonSessionId);
        },
      },
    }, ...pluginResolvers),
  });
}

export async function createContext(request: Request): Promise<Context> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ?? "unknown";

  return { auth: await resolveRequestAuth(request), ip };
}
