import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import { UploadCloud, Check, Copy } from "lucide-react";
import { getOrCreateAnonSessionId } from "../lib/anonSession.js";
import { uploadAnonymousFile } from "../lib/anonUpload.js";
import { authPrimaryButtonClass } from "../components/layout/AuthCard.js";
import { ColorModeToggle } from "../components/layout/ColorModeToggle.js";

interface UploadedItem {
  fileName: string;
  shareUrl: string;
}

/**
 * Public, no-login upload page (Phase 6). Anyone with the link can drop a
 * file and get a share link back — no account required. Files are TTL'd
 * (config.anonymousTTLDays) unless claimed to an account. See
 * docs/hermes/concept.md section 4.7.
 */
export function AnonymousUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [results, setResults] = useState<UploadedItem[]>([]);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const handleFiles = useCallback(async (files: FileList) => {
    setError("");
    setUploading(true);
    const anonSessionId = getOrCreateAnonSessionId();

    for (const file of Array.from(files)) {
      try {
        setProgress(0);
        const { shareUrl } = await uploadAnonymousFile(file, anonSessionId, (uploaded, total) => {
          setProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0);
        });
        setResults((prev) => [{ fileName: file.name, shareUrl }, ...prev]);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to upload ${file.name}`);
      }
    }
    setUploading(false);
    setProgress(0);
  }, []);

  const handleCopy = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  return (
    <div className="relative min-h-screen bg-paper px-4 py-8">
      <ColorModeToggle className="absolute right-4 top-4" />
      <div className="mx-auto max-w-xl">
        <h1 className="font-display text-2xl font-semibold text-ink">Quick upload</h1>
        <p className="mt-1 text-sm text-muted">
          No account needed. Files are kept for a limited time —{" "}
          <Link to="/register" className="text-accent underline-offset-2 hover:underline">
            create an account
          </Link>{" "}
          to keep them permanently.
        </p>

        <input
          type="file"
          ref={fileInputRef}
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
          }}
          className={`mt-6 cursor-pointer rounded-card border-2 border-dashed p-10 text-center transition-colors duration-short ease-out ${
            isDragging ? "border-accent bg-accent/10" : "border-rule hover:border-rule-2"
          }`}
        >
          <UploadCloud size={28} className="mx-auto mb-2 text-muted" />
          <p className="text-sm text-ink-2">
            {uploading ? `Uploading… ${progress}%` : "Click or drop a file here"}
          </p>
        </div>

        {error && <p className="mt-3 text-sm text-error">{error}</p>}

        {results.length > 0 && (
          <div className="mt-6 space-y-3">
            {results.map((r) => (
              <div key={r.shareUrl} className="rounded-card border border-rule bg-paper-2 p-4">
                <p className="mb-2 truncate text-sm font-medium text-ink">{r.fileName}</p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={r.shareUrl}
                    className="flex-1 rounded-md border border-rule-2 bg-paper px-3 py-2 font-mono text-xs text-ink-2 focus:outline-none"
                  />
                  <button
                    onClick={() => handleCopy(r.shareUrl)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
                  >
                    {copiedUrl === r.shareUrl ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                    {copiedUrl === r.shareUrl ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-8 border-t border-rule pt-4 text-center text-sm text-muted">
          <Link to="/login" className={authPrimaryButtonClass + " inline-flex w-auto px-6"}>
            Log in to your account
          </Link>
        </div>
      </div>
    </div>
  );
}
