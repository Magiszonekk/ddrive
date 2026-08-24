// ddrive — Fullscreen image lightbox
//
// Shows a large preview of an image file. Works for both authenticated users
// (fetches the original via fetchBlobBody with JWT) and anonymous sessions
// (X-Anon-Session-Id). Click anywhere / Escape / × closes.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { fetchBlobBody } from "../../lib/api.js";

interface LightboxProps {
  fileId: string;
  fileName: string;
  mimeType: string;
  anonSessionId?: string;
  onClose: () => void;
}

export function ImageLightbox({ fileId, fileName, mimeType, anonSessionId, onClose }: LightboxProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const body = await fetchBlobBody(`${fileId}:chunk:0`, undefined, anonSessionId);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([body], { type: mimeType }));
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId, mimeType, anonSessionId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-modal flex flex-col bg-graphite/95 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="max-w-[80%] truncate text-sm font-medium text-graphite-ink">{fileName}</h2>
        <button
          onClick={onClose}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-graphite-ink/70 transition-colors duration-micro ease-out hover:bg-white/10 hover:text-graphite-ink"
          aria-label="Close preview"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {error ? (
          <p className="text-sm text-error">Preview failed</p>
        ) : src ? (
          <img
            src={src}
            alt={fileName}
            onClick={(e) => {
              e.stopPropagation();
              setZoomed((v) => !v);
            }}
            className={`rounded-card transition-transform duration-short ease-out ${
              zoomed
                ? "max-h-none max-w-none cursor-zoom-out overflow-auto"
                : "max-h-full max-w-full cursor-zoom-in object-contain"
            }`}
          />
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-graphite-ink/30 border-t-graphite-ink" />
            <span className="text-sm text-graphite-ink/70">Loading…</span>
          </div>
        )}
      </div>
    </div>
  );
}
