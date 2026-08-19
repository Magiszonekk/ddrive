import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { fetchBlobBodyShared } from "../lib/api.js";
import { gqlRequest } from "../lib/graphql.js";
import { DOWNLOAD_SUCCESS_EVENT, downloadSharedFolderAsZip } from "../lib/download.js";
import type { ShareAccessResponse } from "@ddv4/types/api";
import { useNotificationStore } from "../stores/notifications.js";
import { AuthCard, authPrimaryButtonClass } from "../components/layout/AuthCard.js";

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
  // allows it — real embeds, not just a download prompt (concept.md 4.5).
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

  if (error && !info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-4">
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-4">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  return (
    <AuthCard title={info.shareType === "FOLDER" ? "Shared folder" : "Shared file"}>
      <div className="mb-6 space-y-1 text-sm text-ink-2">
        <p className="truncate font-medium text-ink">{info.fileName}</p>
        {info.shareType === "FILE" && (
          <p className="font-mono text-xs text-muted">{info.mimeType}</p>
        )}
      </div>

      {info.shareType === "FOLDER" && info.folderContents && (
        <ul className="mb-6 max-h-[50vh] space-y-1 overflow-y-auto rounded-card border border-rule bg-paper-2 p-2">
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
                <span className="font-mono text-xs text-muted">{item.size} B</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {info.shareType === "FILE" && previewUrl && isImage(info.mimeType) && (
        <img src={previewUrl} alt={info.fileName} className="mb-6 max-h-[60vh] w-full rounded-card border border-rule bg-paper-2 object-contain" />
      )}
      {info.shareType === "FILE" && previewUrl && isVideo(info.mimeType) && (
        <video src={previewUrl} controls autoPlay className="mb-6 max-h-[60vh] w-full rounded-card border border-rule bg-paper-2" />
      )}
      {info.shareType === "FILE" && previewUrl && isAudio(info.mimeType) && (
        <audio src={previewUrl} controls className="mb-6 w-full" />
      )}

      {info.shareType === "FOLDER" ? (
        <button
          onClick={handleDownloadFolder}
          disabled={downloading || !info.allowContent}
          className={authPrimaryButtonClass}
        >
          {downloading ? "Preparing ZIP…" : "Download all (ZIP)"}
        </button>
      ) : (
        <button
          onClick={handleDownload}
          disabled={downloading || !info.allowContent}
          className={authPrimaryButtonClass}
        >
          {downloading ? "Downloading…" : "Download"}
        </button>
      )}
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </AuthCard>
  );
}
