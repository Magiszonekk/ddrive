// ddrive — Anonymous workspace GraphQL API (Phase 8)
//
// Thin wrappers around the anon-scoped queries/mutations. No auth token —
// the anonSessionId (browser localStorage UUID) IS the scoping. Mirrors
// gqlRequest but never attaches an Authorization header.

import { getGraphQLClient, gqlRequest } from "./graphql.js";

export interface AnonymousItem {
  id: string;
  kind: "FILE" | "FOLDER";
  name: string | null;
  mimeType: string | null;
  thumbnailBlobId: string | null;
  totalBytes: string;
  itemCount: number | null;
  status: string;
  parentFolderId: string | null;
  expiresAt: string | null;
  createdAt: string;
  chunkCount: number;
}

const ANON_FILES_QUERY = `
  query AnonFiles($anonSessionId: String!, $parentFolderId: ID) {
    anonymousFiles(anonSessionId: $anonSessionId, parentFolderId: $parentFolderId) {
      id kind name mimeType thumbnailBlobId totalBytes itemCount status parentFolderId expiresAt createdAt chunkCount
    }
  }
`;

const ANON_FOLDER_PATH_QUERY = `
  query AnonFolderPath($anonSessionId: String!, $folderId: ID!) {
    anonymousFolderPath(anonSessionId: $anonSessionId, folderId: $folderId) {
      id kind name mimeType thumbnailBlobId totalBytes itemCount status parentFolderId expiresAt createdAt chunkCount
    }
  }
`;

const CREATE_ANON_FOLDER = `
  mutation CreateAnonFolder($name: String!, $parentFolderId: ID, $anonSessionId: String!) {
    createAnonymousFolder(name: $name, parentFolderId: $parentFolderId, anonSessionId: $anonSessionId) {
      id kind name
    }
  }
`;

const RENAME_ANON_FOLDER = `
  mutation RenameAnonFolder($folderId: ID!, $name: String!, $anonSessionId: String!) {
    renameAnonymousFolder(folderId: $folderId, name: $name, anonSessionId: $anonSessionId)
  }
`;

const DELETE_ANON_FOLDER = `
  mutation DeleteAnonFolder($folderId: ID!, $anonSessionId: String!) {
    deleteAnonymousFolder(folderId: $folderId, anonSessionId: $anonSessionId)
  }
`;

const MOVE_ANON_FOLDER = `
  mutation MoveAnonFolder($folderId: ID!, $parentFolderId: ID, $anonSessionId: String!) {
    moveAnonymousFolder(folderId: $folderId, parentFolderId: $parentFolderId, anonSessionId: $anonSessionId)
  }
`;

const MOVE_ANON_FILE = `
  mutation MoveAnonFile($fileId: ID!, $parentFolderId: ID, $anonSessionId: String!) {
    moveAnonymousFile(fileId: $fileId, parentFolderId: $parentFolderId, anonSessionId: $anonSessionId)
  }
`;

const EXTEND_ANON_TTL = `
  mutation ExtendAnonTTL($fileId: ID!, $anonSessionId: String!) {
    extendAnonymousTTL(fileId: $fileId, anonSessionId: $anonSessionId)
  }
`;

export async function getAnonymousFiles(
  anonSessionId: string,
  parentFolderId: string | null,
): Promise<AnonymousItem[]> {
  const result = await gqlRequest<{ anonymousFiles: AnonymousItem[] }>(
    ANON_FILES_QUERY,
    { anonSessionId, parentFolderId },
  );
  return result.anonymousFiles;
}

export async function getAnonymousFolderPath(
  anonSessionId: string,
  folderId: string,
): Promise<AnonymousItem[]> {
  const result = await gqlRequest<{ anonymousFolderPath: AnonymousItem[] }>(
    ANON_FOLDER_PATH_QUERY,
    { anonSessionId, folderId },
  );
  return result.anonymousFolderPath;
}

export async function createAnonymousFolder(
  name: string,
  parentFolderId: string | null,
  anonSessionId: string,
): Promise<{ id: string }> {
  const result = await gqlRequest<{ createAnonymousFolder: { id: string } }>(
    CREATE_ANON_FOLDER,
    { name, parentFolderId, anonSessionId },
  );
  return result.createAnonymousFolder;
}

export async function renameAnonymousFolder(
  folderId: string,
  name: string,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ renameAnonymousFolder: boolean }>(
    RENAME_ANON_FOLDER,
    { folderId, name, anonSessionId },
  );
  return result.renameAnonymousFolder;
}

export async function deleteAnonymousFolder(
  folderId: string,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ deleteAnonymousFolder: boolean }>(
    DELETE_ANON_FOLDER,
    { folderId, anonSessionId },
  );
  return result.deleteAnonymousFolder;
}

export async function moveAnonymousFolder(
  folderId: string,
  parentFolderId: string | null,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ moveAnonymousFolder: boolean }>(
    MOVE_ANON_FOLDER,
    { folderId, parentFolderId, anonSessionId },
  );
  return result.moveAnonymousFolder;
}

export async function moveAnonymousFile(
  fileId: string,
  parentFolderId: string | null,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ moveAnonymousFile: boolean }>(
    MOVE_ANON_FILE,
    { fileId, parentFolderId, anonSessionId },
  );
  return result.moveAnonymousFile;
}

export async function extendAnonymousTTL(
  fileId: string,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ extendAnonymousTTL: boolean }>(
    EXTEND_ANON_TTL,
    { fileId, anonSessionId },
  );
  return result.extendAnonymousTTL;
}

const CREATE_ANON_FOLDER_SHARE = `\n  mutation CreateAnonFolderShare($folderId: ID!, $allowContent: Boolean!, $allowPreview: Boolean) {\n    createAnonymousFolderShare(folderId: $folderId, allowContent: $allowContent, allowPreview: $allowPreview) {\n      shareId token\n    }\n  }\n`;

export async function createAnonymousFolderShare(
  folderId: string,
  allowContent: boolean,
  allowPreview: boolean,
): Promise<{ shareId: string; token: string }> {
  const result = await gqlRequest<{ createAnonymousFolderShare: { shareId: string; token: string } }>(
    CREATE_ANON_FOLDER_SHARE,
    { folderId, allowContent, allowPreview },
  );
  return result.createAnonymousFolderShare;
}

const DELETE_ANON_FILE = `
  mutation DeleteAnonFile($fileId: ID!, $anonSessionId: String!) {
    deleteAnonymousFile(fileId: $fileId, anonSessionId: $anonSessionId)
  }
`;

export async function deleteAnonymousFile(
  fileId: string,
  anonSessionId: string,
): Promise<boolean> {
  const result = await gqlRequest<{ deleteAnonymousFile: boolean }>(
    DELETE_ANON_FILE,
    { fileId, anonSessionId },
  );
  return result.deleteAnonymousFile;
}

// Keep getGraphQLClient exported for callers that need raw access
export { getGraphQLClient };
