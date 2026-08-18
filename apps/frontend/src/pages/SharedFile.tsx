import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { fetchBlobBodyShared } from "../lib/api.js";
import { gqlRequest } from "../lib/graphql.js";
import { DOWNLOAD_SUCCESS_EVENT } from "../lib/download.js";
import type { ShareAccessResponse } from "@ddv4/types/api";
import { useNotificationStore } from "../stores/notifications.js";
import { AuthCard, authPrimaryButtonClass } from "../components/layout/AuthCard.js";

const ACCESS_SHARE = `
  query AccessShare($shareId: ID!, $token: String!) {
    accessShare(shareId: $shareId, token: $token) {
      shareId
      fileId
      name
      mimeType
      chunkCount
      allowContent
      allowPreview
    }
  }
`;

interface ResolvedShareInfo {
  shareId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  chunkCount: number;
  allowContent: boolean;
  allowPreview: boolean;
  token: string;
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

    const token = window.location.hash.replace(/^#/, "");
    if (!token) {
      setError("Share token not found in URL fragment");
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
          fileId: accessShare.fileId,
          fileName: accessShare.name ?? "shared-file",
          mimeType: accessShare.mimeType ?? "application/octet-stream",
          chunkCount: accessShare.chunkCount,
          allowContent: accessShare.allowContent,
          allowPreview: accessShare.allowPreview,
          token,
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
    <AuthCard title="Shared file">
      <div className="mb-6 space-y-1 text-sm text-ink-2">
        <p className="truncate font-medium text-ink">{info.fileName}</p>
        <p className="font-mono text-xs text-muted">{info.mimeType}</p>
      </div>

      {previewUrl && isImage(info.mimeType) && (
        <img src={previewUrl} alt={info.fileName} className="mb-6 max-h-[60vh] w-full rounded-card border border-rule bg-paper-2 object-contain" />
      )}
      {previewUrl && isVideo(info.mimeType) && (
        <video src={previewUrl} controls autoPlay className="mb-6 max-h-[60vh] w-full rounded-card border border-rule bg-paper-2" />
      )}
      {previewUrl && isAudio(info.mimeType) && (
        <audio src={previewUrl} controls className="mb-6 w-full" />
      )}

      <button
        onClick={handleDownload}
        disabled={downloading || !info.allowContent}
        className={authPrimaryButtonClass}
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </AuthCard>
  );
}
