import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { fetchBlobBodyShared } from "../lib/api.js";
import { gqlRequest } from "../lib/graphql.js";
import { DOWNLOAD_SUCCESS_EVENT, downloadSharedFolderAsZip } from "../lib/download.js";
import type { ShareAccessResponse } from "@ddv4/types/api";
import { useNotificationStore } from "../stores/notifications.js";
import { Download, Lock, Folder } from "lucide-react";

const ACCESS_SHARE = `
  query AccessShare($shareId: ID!, $token: String!) {
    accessShare(shareId: $shareId, token: $token) {
      shareId
      shareType
      fileId
      folderId
      name
      mimeType
      chunkCount
      allowContent
      allowPreview
      folderContents {
        id
        name
        mimeType
        size
        thumbnailBlobId
        chunkCount
        kind
      }
    }
  }
`;

interface ResolvedShareInfo {
  shareId: string;
  shareType: "FILE" | "FOLDER";
  fileId: string;
  folderId: string | null;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  allowContent: boolean;
  allowPreview: boolean;
  token: string;
  folderContents?: ShareAccessResponse["folderContents"];
}

function isImage(mimeType: string) { return mimeType.startsWith("image/"); }
function isVideo(mimeType: string) { return mimeType.startsWith("video/"); }
function isAudio(mimeType: string) { return mimeType.startsWith("audio/"); }

function fileEmoji(mimeType: string): string {
  if (isImage(mimeType)) return "🖼️";
  if (isVideo(mimeType)) return "🎬";
  if (isAudio(mimeType)) return "🎵";
  if (mimeType.includes("pdf")) return "📕";
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "🗜️";
  if (mimeType.startsWith("text/")) return "📝";
  return "📄";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SharedFile() {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<ResolvedShareInfo | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const pushNotification = useNotificationStore((s) => s.push);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ fileName: string; bytes: number }>).detail;
      if (!detail) return;
      pushNotification("success", `Download started: ${detail.fileName} (${detail.bytes} B)`);
    };
    window.addEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
    return () => window.removeEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
  }, [pushNotification]);

  useEffect(() => {
    if (!shareId) return;

    const token = new URLSearchParams(window.location.search).get("t") ?? window.location.hash.replace(/^#/, "");
    if (!token) {
      setError("Share token not found in URL");
      return;
    }

    (async () => {
      try {
        const { accessShare } = await gqlRequest<{ accessShare: ShareAccessResponse | null }>(ACCESS_SHARE, {
          shareId,
          token,
        });

        if (!accessShare) {
          setError("Share link not found or expired");
          return;
        }

        setInfo({
          shareId: accessShare.shareId,
          shareType: accessShare.shareType,
          fileId: accessShare.fileId,
          folderId: accessShare.folderId,
          fileName: accessShare.name ?? "shared-file",
          mimeType: accessShare.mimeType ?? "application/octet-stream",
          chunkCount: accessShare.chunkCount,
          allowContent: accessShare.allowContent,
          allowPreview: accessShare.allowPreview,
          token,
          folderContents: accessShare.folderContents,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load share");
      }
    })();
  }, [shareId]);

  // Auto-load an inline preview for images/small video/audio when the share
  // allows it — real embeds, not just a download prompt.
  useEffect(() => {
    if (!info || !shareId || !info.allowPreview) return;
    if (!isImage(info.mimeType) && !isVideo(info.mimeType) && !isAudio(info.mimeType)) return;

    let revoked = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const buffers: ArrayBuffer[] = [];
        for (let i = 0; i < info.chunkCount; i++) {
          const body = await fetchBlobBodyShared(`${info.fileId}:chunk:${i}`, shareId, info.token);
          buffers.push(body);
        }
        if (revoked) return;
        objectUrl = URL.createObjectURL(new Blob(buffers, { type: info.mimeType }));
        setPreviewUrl(objectUrl);
      } catch {
        // fall back to download-only UI
      }
    })();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [info, shareId]);

  const handleDownload = async () => {
    if (!shareId || !info) return;
    setDownloading(true);
    setError("");
    try {
      const buffers: ArrayBuffer[] = [];
      for (let i = 0; i < info.chunkCount; i++) {
        const body = await fetchBlobBodyShared(`${info.fileId}:chunk:${i}`, shareId, info.token);
        buffers.push(body);
      }
      const blob = new Blob(buffers, { type: info.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = info.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.dispatchEvent(new CustomEvent(DOWNLOAD_SUCCESS_EVENT, { detail: { fileName: info.fileName, bytes: blob.size } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setError(message);
      pushNotification("error", message);
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadFolder = async () => {
    if (!shareId || !info || !info.folderContents) return;
    setDownloading(true);
    setError("");
    try {
      await downloadSharedFolderAsZip(
        shareId,
        info.token,
        info.fileName,
        info.folderContents,
      );
      window.dispatchEvent(new CustomEvent(DOWNLOAD_SUCCESS_EVENT, { detail: { fileName: `${info.fileName}.zip`, bytes: 0 } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setError(message);
      pushNotification("error", message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-rule px-5 py-3">
        <a href="/drop" className="flex items-center gap-2 font-display text-base font-semibold text-ink">
          <span className="text-accent">ddrive</span>
        </a>
        <a
          href="/drop"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
        >
          Upload your own →
        </a>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        {error && !info ? (
          <div className="w-full max-w-md rounded-card border border-rule bg-paper p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-error/10 text-error">
              <Lock size={22} />
            </div>
            <h1 className="font-display text-lg font-semibold text-ink">Link unavailable</h1>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <a
              href="/drop"
              className="mt-6 inline-flex h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover"
            >
              Go to ddrive
            </a>
          </div>
        ) : !info ? (
          <div className="flex flex-col items-center gap-3 text-muted">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-rule-2 border-t-accent" />
            <p className="text-sm">Loading shared file…</p>
          </div>
        ) : (
          <div className="w-full max-w-lg rounded-card border border-rule bg-paper p-6 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)] md:p-8">
            <div className="mb-5 flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card bg-paper-2 text-3xl">
                {info.shareType === "FOLDER" ? <Folder size={28} className="text-ink-2" /> : fileEmoji(info.mimeType)}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate font-display text-lg font-semibold text-ink" title={info.fileName}>
                  {info.fileName}
                </h1>
                <p className="mt-0.5 text-sm text-muted">
                  {info.shareType === "FOLDER"
                    ? `${info.folderContents?.length ?? 0} item(s) in this folder`
                    : info.mimeType}
                </p>
              </div>
            </div>

            {info.shareType === "FOLDER" && info.folderContents && (
              <ul className="mb-5 max-h-[40vh] space-y-1 overflow-y-auto rounded-card border border-rule bg-paper-2 p-2">
                {info.folderContents.length === 0 && (
                  <li className="px-2 py-3 text-sm text-muted">This folder is empty.</li>
                )}
                {info.folderContents.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 truncate rounded-md px-2 py-2 text-sm text-ink"
                  >
                    <span className="text-muted">{item.kind === "FOLDER" ? "📁" : "📄"}</span>
                    <span className="min-w-0 flex-1 truncate">{item.name ?? item.id}</span>
                    {item.kind === "FILE" && (
                      <span className="font-mono text-xs text-muted">{formatBytes(Number(item.size) || 0)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {info.shareType === "FILE" && previewUrl && isImage(info.mimeType) && (
              <img
                src={previewUrl}
                alt={info.fileName}
                className="mb-5 max-h-[55vh] w-full rounded-card border border-rule bg-paper-2 object-contain"
              />
            )}
            {info.shareType === "FILE" && previewUrl && isVideo(info.mimeType) && (
              <video src={previewUrl} controls autoPlay className="mb-5 max-h-[55vh] w-full rounded-card border border-rule bg-paper-2" />
            )}
            {info.shareType === "FILE" && previewUrl && isAudio(info.mimeType) && (
              <audio src={previewUrl} controls className="mb-5 w-full" />
            )}

            <button
              onClick={info.shareType === "FOLDER" ? handleDownloadFolder : handleDownload}
              disabled={downloading || !info.allowContent}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {downloading ? (
                <>Preparing…</>
              ) : (
                <>
                  <Download size={18} />
                  {info.shareType === "FOLDER" ? "Download folder (ZIP)" : "Download file"}
                </>
              )}
            </button>

            {!info.allowContent && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-sm text-muted">
                <Lock size={14} /> Download disabled by the sender
              </p>
            )}

            {error && <p className="mt-3 text-sm text-error">{error}</p>}

            <p className="mt-5 text-center text-xs text-muted">
              Shared via <span className="font-medium text-ink-2">ddrive</span> · files expire automatically after 30 days
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
