import { useEffect, useState } from "react";
import { Film, FileText, Music, File as FileIcon } from "lucide-react";
import { fetchBlobBody } from "../../lib/api.js";

interface ThumbnailProps {
  fileId: string;
  thumbnailBlobId?: string | null;
  mimeType: string;
  className?: string;
  anonSessionId?: string;
}

const objectUrlCache = new Map<string, string>();

function iconFor(mimeType: string) {
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") return FileText;
  return FileIcon;
}

/** Lowres thumbnail with an icon fallback while loading / when none exists. */
export function Thumbnail({ fileId, thumbnailBlobId, mimeType, className, anonSessionId }: ThumbnailProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(
    thumbnailBlobId ? objectUrlCache.get(thumbnailBlobId) ?? null : null,
  );

  useEffect(() => {
    if (!thumbnailBlobId) return;
    const cached = objectUrlCache.get(thumbnailBlobId);
    if (cached) {
      setObjectUrl(cached);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const body = await fetchBlobBody(thumbnailBlobId, undefined, anonSessionId);
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([body]));
        objectUrlCache.set(thumbnailBlobId, url);
        setObjectUrl(url);
      } catch {
        // fall through to icon fallback
      }
    })();

    return () => { cancelled = true; };
  }, [thumbnailBlobId]);

  // Small files (already lowres) have no thumbnailBlobId but ARE previewable
  // directly when they're an image — use the original as its own preview.
  const useOriginalAsPreview = false; // thumbnails are now always generated (thumbnail.ts)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!useOriginalAsPreview) return;
    const cached = objectUrlCache.get(fileId);
    if (cached) {
      setOriginalUrl(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const body = await fetchBlobBody(`${fileId}:chunk:0`);
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
        objectUrlCache.set(fileId, url);
        setOriginalUrl(url);
      } catch {
        // fall through to icon fallback
      }
    })();
    return () => { cancelled = true; };
  }, [useOriginalAsPreview, fileId, mimeType]);

  const src = objectUrl ?? originalUrl;

  if (src) {
    return <img src={src} alt="" className={className ?? "h-full w-full object-cover"} loading="lazy" />;
  }

  const Icon = iconFor(mimeType);
  return (
    <div className={className ?? "flex h-full w-full items-center justify-center bg-paper-2"}>
      <Icon size={28} className="text-muted" />
    </div>
  );
}
