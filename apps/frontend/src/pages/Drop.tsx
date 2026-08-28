// ddrive — Unified anonymous "drop" page (replaces /upload + /drive).
//
// Industry-aligned temp-file-share UX (WeTransfer / SwissTransfer style):
// a big drag-and-drop zone at the top, an optional folder/empty state, and a
// file list below. No account required. Files auto-expire (config.anonymousTTLDays).
// A small "i" button opens an info modal explaining how it works.

import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UploadCloud,
  Info,
  LogIn,
  FolderPlus,
  RefreshCw,
  Clock,
} from "lucide-react";
import { useNotificationStore } from "../stores/notifications.js";
import { FileTable, type FileItem, type FolderItem } from "../components/files/FileTable.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { ShareModal } from "../components/files/ShareModal.js";
import { NewFolderModal } from "../components/files/NewFolderModal.js";
import { RenameFolderModal } from "../components/files/RenameFolderModal.js";
import { ImageLightbox } from "../components/media/ImageLightbox.js";
import { VideoPlayer } from "../components/video/VideoPlayer.js";
import {
  getAnonymousFiles,
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
import { InfoModal } from "../components/files/InfoModal.js";
import { authPrimaryButtonClass } from "../components/layout/AuthCard.js";
import { ColorModeToggle } from "../components/layout/ColorModeToggle.js";

const TTL_DAYS = 30; // mirrors config.anonymousTTLDays on the server

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

export function Drop() {
  const anonSessionId = useMemo(() => getOrCreateAnonSessionId(), []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushNotification = useNotificationStore((s) => s.push);
  const [lightboxFile, setLightboxFile] = useState<FileItem | null>(null);
  const [playingFile, setPlayingFile] = useState<FileItem | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const currentFolderId = searchParams.get("folder");

  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FolderItem | null>(null);
  const [sharingFile, setSharingFile] = useState<FileItem | null>(null);
  const [sharingFolder, setSharingFolder] = useState<FolderItem | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: items = [], isLoading, refetch } = useQuery({
    queryKey: ["anonFiles", anonSessionId, currentFolderId ?? "root"],
    queryFn: () => getAnonymousFiles(anonSessionId, currentFolderId),
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      const pending = rows.some(
        (it) =>
          it.kind === "FILE" &&
          it.status === "READY" &&
          !it.thumbnailBlobId &&
          (it.mimeType?.startsWith("image/") || it.mimeType?.startsWith("video/")),
      );
      return pending ? 3000 : false;
    },
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
          chunkCount: f.chunkCount ?? Math.max(1, Math.ceil(Number(f.totalBytes) / (8 * 1024 * 1024))),
          thumbnailBlobId: f.thumbnailBlobId,
          status: f.status,
          createdAt: f.createdAt,
          expiresAt: f.expiresAt,
        })),
    [items],
  );

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["anonFiles", anonSessionId, currentFolderId ?? "root"],
    });
  }, [queryClient, anonSessionId, currentFolderId]);

  const openFolder = (id: string) => setSearchParams({ folder: id });

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      setUploadProgress(0);
      try {
        for (const file of Array.from(fileList)) {
          const { shareUrl } = await uploadAnonymousFile(
            file,
            anonSessionId,
            (done, total) => setUploadProgress(total ? Math.round((done / total) * 100) : 0),
            currentFolderId,
          );
          if (shareUrl) {
            navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
            pushNotification("success", `Uploaded ${file.name} — share link copied`);
          }
        }
        refresh();
      } catch (err) {
        pushNotification("error", err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        setUploadProgress(0);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [anonSessionId, currentFolderId, refresh, pushNotification],
  );

  const handleDownload = async (file: FileItem) => {
    try {
      await downloadFile({
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        manifestBlobId: `${file.id}:chunk:${Math.max(0, file.chunkCount - 1)}`,
        anonSessionId,
        chunkCount: file.chunkCount,
      });
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Download failed");
    }
  };

  const handleShare = (file: FileItem) => setSharingFile(file);
  const handleShareFolder = (folder: FolderItem) => setSharingFolder(folder);

  const handleDelete = async (file: FileItem) => {
    try {
      await deleteAnonymousFile(file.id, anonSessionId);
      refresh();
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleDeleteFolder = async (folder: FolderItem) => {
    try {
      await deleteAnonymousFolder(folder.id, anonSessionId);
      refresh();
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleRenameFolder = (folder: FolderItem) => setRenamingFolder(folder);

  const handleMoveFile = async (fileId: string, targetFolderId: string | null) => {
    try {
      await moveAnonymousFile(fileId, targetFolderId, anonSessionId);
      refresh();
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Move failed");
    }
  };

  const handleMoveFolder = async (folderId: string, targetFolderId: string | null) => {
    try {
      await moveAnonymousFolder(folderId, targetFolderId, anonSessionId);
      refresh();
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Move failed");
    }
  };

  const handleExtendTtl = async (file: FileItem) => {
    try {
      await extendAnonymousTTL(file.id, anonSessionId);
      refresh();
      pushNotification("success", "TTL extended");
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Failed to extend TTL");
    }
  };

  const hasFiles = files.length > 0 || folders.length > 0;

  return (
    <div className="relative min-h-screen bg-paper px-4 py-8">
      <ColorModeToggle className="absolute right-4 top-4" />

      {/* Top bar: title + info + auth */}
      <div className="mx-auto mb-6 flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-2xl font-semibold text-ink">ddrive</h1>
          <button
            onClick={() => setShowInfo(true)}
            title="How it works"
            aria-label="How it works"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-rule-2 bg-paper text-muted transition-colors duration-short hover:bg-paper-2 hover:text-ink"
          >
            <Info size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewFolder(true)}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-sm font-medium text-ink transition-colors duration-short hover:bg-paper-2"
          >
            <FolderPlus size={16} /> New folder
          </button>
          <button
            onClick={() => navigate("/login")}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-sm font-medium text-ink transition-colors duration-short hover:bg-paper-2"
          >
            <LogIn size={16} /> Log in
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-5xl">
        {/* Hero drag & drop */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
          }}
          className={`cursor-pointer rounded-card border-2 border-dashed p-12 text-center transition-colors duration-short ease-out ${
            isDragging ? "border-accent bg-accent/10" : "border-rule hover:border-rule-2"
          }`}
        >
          <UploadCloud size={40} className={`mx-auto mb-3 ${isDragging ? "text-accent" : "text-muted"}`} />
          <p className="text-base font-medium text-ink">
            {uploading ? `Uploading… ${uploadProgress}%` : "Drop files here or click to upload"}
          </p>
          <p className="mt-1 text-sm text-muted">
            No account needed. Files are kept for {TTL_DAYS} days, then deleted automatically.
          </p>
          {uploading && (
            <div className="mx-auto mt-4 h-2 w-48 overflow-hidden rounded-full bg-paper-2">
              <div
                className="h-full bg-accent transition-all duration-short"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {/* Breadcrumb (when inside a folder) */}
        {currentFolderId && (
          <div className="mt-6">
            <FolderBreadcrumb
              folderId={currentFolderId}
              anonSessionId={anonSessionId}
              onMoveFile={handleMoveFile}
              onMoveFolder={handleMoveFolder}
            />
          </div>
        )}

        {/* File list */}
        <div className="mt-6">
          {isLoading ? (
            <p className="py-16 text-center text-sm text-muted">Loading…</p>
          ) : !hasFiles ? (
            <div className="rounded-card border border-rule bg-paper-2/40 py-12 text-center">
              <Clock size={28} className="mx-auto mb-2 text-muted" />
              <p className="text-sm text-muted">
                Nothing here yet. Drop a file above to get started — it&rsquo;ll be available for{" "}
                {TTL_DAYS} days and you&rsquo;ll get a share link automatically.
              </p>
              <Link to="/register" className="mt-3 inline-block text-sm text-accent underline-offset-2 hover:underline">
                Create an account to keep files permanently
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm text-muted">Your files on this browser</p>
                <button
                  onClick={() => refetch()}
                  title="Refresh"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-rule-2 bg-paper text-muted transition-colors duration-short hover:bg-paper-2 hover:text-ink"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <FileTable
                files={files}
                folders={folders}
                onDownload={handleDownload}
                onPreview={(file) => {
                  if (file.mimeType.startsWith("image/")) setLightboxFile(file);
                  else handleDownload(file);
                }}
                onPlay={(file) => {
                  if (file.mimeType.startsWith("video/") || file.mimeType.startsWith("audio/"))
                    setPlayingFile(file);
                  else handleDownload(file);
                }}
                onShare={handleShare}
                onShareFolder={handleShareFolder}
                onDelete={handleDelete}
                onDownloadFolder={undefined}
                onRenameFolder={handleRenameFolder}
                onDeleteFolder={handleDeleteFolder}
                onMoveFile={handleMoveFile}
                onMoveFolder={handleMoveFolder}
                onExtendTtl={handleExtendTtl}
                anonSessionId={anonSessionId}
                onOpenFolder={openFolder}
              />
            </>
          )}
        </div>
      </div>

      {sharingFile && (
        <ShareModal
          file={{ id: sharingFile.id, name: sharingFile.name }}
          anonSessionId={anonSessionId}
          onClose={() => setSharingFile(null)}
        />
      )}
      {sharingFolder && (
        <ShareModal
          file={{ id: sharingFolder.id, name: sharingFolder.name }}
          folderId={sharingFolder.id}
          anonSessionId={anonSessionId}
          onClose={() => setSharingFolder(null)}
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
      {lightboxFile && (
        <ImageLightbox
          fileId={lightboxFile.id}
          fileName={lightboxFile.name}
          mimeType={lightboxFile.mimeType}
          anonSessionId={anonSessionId}
          onClose={() => setLightboxFile(null)}
        />
      )}
      {playingFile && (
        <VideoPlayer
          file={{ fileId: playingFile.id, fileName: playingFile.name, mimeType: playingFile.mimeType }}
          onClose={() => setPlayingFile(null)}
        />
      )}
      {showInfo && <InfoModal onClose={() => setShowInfo(false)} />}
    </div>
  );
}
