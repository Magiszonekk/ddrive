import { useEffect, useState } from "react";
import { useParams } from "react-router";
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
      primaryManifestBlobId
      allowContent
      allowPreview
    }
  }
`;

interface ResolvedShareInfo {
  shareId: string;
  fileName: string;
  mimeType: string;
  allowContent: boolean;
  manifestBlobId: string;
  token: string;
}

export function SharedFile() {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<ResolvedShareInfo | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
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
          fileName: accessShare.name ?? "shared-file",
          mimeType: accessShare.mimeType ?? "application/octet-stream",
          allowContent: accessShare.allowContent,
          manifestBlobId: accessShare.primaryManifestBlobId ?? "",
          token,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load share");
      }
    })();
  }, [shareId]);

  const handleDownload = async () => {
    if (!shareId || !info) return;
    setDownloading(true);
    setError("");
    try {
      // TODO(Phase 4): rewrite download to fetch plaintext chunks directly
      const response = await fetch(`/api/blob/${info.manifestBlobId}`, {
        headers: {
          "x-share-id": shareId,
          "x-share-token": info.token,
        },
      });
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = info.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
