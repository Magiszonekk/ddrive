// ddrive — Anonymous workspace (Phase 8)
//
// A full "logged-out drive": table/grid of the browser's anonymous uploads,
// folder navigation, thumbnails, metadata (size, created date, TTL), sharing,
// and folder management. No JWT — scoped by the browser's anonSessionId.

import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Upload as UploadIcon, RefreshCw, LogIn, Clock, AlertTriangle } from "lucide-react";
import { FileTable, type FileItem, type FolderItem } from "../components/files/FileTable.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { ShareModal } from "../components/files/ShareModal.js";
import { NewFolderModal } from "../components/files/NewFolderModal.js";
import { RenameFolderModal } from "../components/files/RenameFolderModal.js";
import {
  getAnonymousFiles,
  getAnonymousFolderPath,
  createAnonymousFolder,
  renameAnonymousFolder,
  deleteAnonymousFolder,
  moveAnonymousFolder,
  moveAnonymousFile,
  extendAnonymousTTL,
  deleteAnonymousFile,
} from "../lib/anonApi.js";
import { getOrCreateAnonSessionId } from "../lib/anonSession.js";
import { uploadAnonymousFile } from "../lib/anonUpload.js";
import { downloadFile } from "../lib/download.js";
import { Thumbnail } from "../components/files/Thumbnail.js";
import { fetchBlobBody } from "../lib/api.js";
import { useAuthStore } from "../stores/auth.js";

function formatSizeLabel(bytes: string): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

function formatTtlLabel(expiresAt: string | null): string {
  if (!expiresAt) return "—";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

export function AnonymousDrive() {
  const anonSessionId = useMemo(() => getOrCreateAnonSessionId(), []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentFolderId = searchParams.get("folder");

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FolderItem | null>(null);
  const [sharingFile, setSharingFile] = useState<FileItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey: ["anonFiles", anonSessionId, currentFolderId ?? "root"],
    queryFn: () => getAnonymousFiles(anonSessionId, currentFolderId),
  });

  const folders: FolderItem[] = useMemo(
    () =>
      items
        .filter((it) => it.kind === "FOLDER")
        .map((f) => ({
          id: f.id,
          name: f.name ?? "Untitled",
          subfolderCount: 0,
          fileCount: f.itemCount ?? 0,
          totalSizeBytes: f.totalBytes,
        })),
    [items],
  );

  const files: FileItem[] = useMemo(
    () =>
      items
        .filter((it) => it.kind === "FILE")
        .map((f) => ({
          id: f.id,
          name: f.name ?? "Untitled",
          mimeType: f.mimeType ?? "application/octet-stream",
          size: f.totalBytes,
          chunkSize: 8 * 1024 * 1024,
          chunkCount: Math.max(1, Math.ceil(Number(f.totalBytes) / (8 * 1024 * 1024))),
          thumbnailBlobId: f.thumbnailBlobId,
          status: f.status,
          createdAt: f.createdAt,
        })),
    [items],
  );

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["anonFiles", anonSessionId, currentFolderId ?? "root"] });
  }, [queryClient, anonSessionId, currentFolderId]);

  const openFolder = (id: string) => {
    setSearchParams({ folder: id });
  };

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      for (const file of Array.from(fileList)) {
        await uploadAnonymousFile(file, anonSessionId, (done, total) => {
          setUploadProgress(total ? Math.round((done / total) * 100) : 0);
        }, currentFolderId);
      }
      refresh();
      alert("Upload complete");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDownload = async (file: FileItem) => {
    try {
      await downloadFile({
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        manifestBlobId: `${file.id}:chunk:${Math.max(0, Math.ceil(Number(file.size) / (8 * 1024 * 1024)) - 1)}`,
        anonSessionId,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  };

  const handleShare = (file: FileItem) => setSharingFile(file);

  const handleDelete = async (file: FileItem) => {
    try {
      await deleteAnonymousFile(file.id, anonSessionId);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleDeleteFolder = async (folder: FolderItem) => {
    try {
      await deleteAnonymousFolder(folder.id, anonSessionId);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleRenameFolder = (folder: FolderItem) => setRenamingFolder(folder);

  const handleMoveFile = async (fileId: string, targetFolderId: string | null) => {
    try {
      await moveAnonymousFile(fileId, targetFolderId, anonSessionId);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Move failed");
    }
  };

  const handleMoveFolder = async (folderId: string, targetFolderId: string | null) => {
    try {
      await moveAnonymousFolder(folderId, targetFolderId, anonSessionId);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Move failed");
    }
  };

  const handleExtendTtl = async (file: FileItem) => {
    try {
      await extendAnonymousTTL(file.id, anonSessionId);
      refresh();
      alert("TTL extended");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Your files</h1>
          <p className="mt-1 text-sm text-muted">
            Stored without an account. These are visible only in this browser. They auto-expire after 30 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewFolder(true)}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-sm font-medium text-ink transition-colors duration-short ease-out hover:bg-paper-2"
          >
            <FolderPlus size={16} /> New folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-2"
          >
            <UploadIcon size={16} /> {uploading ? `Uploading ${uploadProgress}%` : "Upload"}
          </button>
          <button
            onClick={() => refetch()}
            title="Refresh"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-rule-2 bg-paper text-muted transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => navigate("/login")}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-sm font-medium text-ink transition-colors duration-short ease-out hover:bg-paper-2"
          >
            <LogIn size={16} /> Log in
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
        </div>
      </div>

      <div className="mb-4">
        <FolderBreadcrumb
          folderId={currentFolderId}
          anonSessionId={anonSessionId}
          onMoveFile={handleMoveFile}
          onMoveFolder={handleMoveFolder}
        />
      </div>

      {isLoading ? (
        <p className="py-16 text-center text-sm text-muted">Loading…</p>
      ) : (
        <FileTable
          files={files}
          folders={folders}
          onDownload={handleDownload}
          onPreview={handleDownload}
          onPlay={handleDownload}
          onShare={handleShare}
          onDelete={handleDelete}
          onDownloadFolder={undefined}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onMoveFile={handleMoveFile}
          onMoveFolder={handleMoveFolder}
          onExtendTtl={handleExtendTtl}
        />
      )}

      {sharingFile && (
        <ShareModal
          file={{ id: sharingFile.id, name: sharingFile.name }}
          anonSessionId={anonSessionId}
          onClose={() => setSharingFile(null)}
        />
      )}

      {showNewFolder && (
        <NewFolderModal
          parentFolderId={currentFolderId}
          anonSessionId={anonSessionId}
          onCreated={refresh}
          onClose={() => setShowNewFolder(false)}
        />
      )}

      {renamingFolder && (
        <RenameFolderModal
          folder={renamingFolder}
          anonSessionId={anonSessionId}
          onRenamed={refresh}
          onClose={() => setRenamingFolder(null)}
        />
      )}
    </div>
  );
}
