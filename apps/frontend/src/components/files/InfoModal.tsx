// ddrive — Informational modal for the anonymous /drop page.
// Explains how the service works, the 30-day TTL, no-account model, and
// privacy/disclaimer. Triggered by the "i" button.

import { X, Clock, ShieldCheck, UserX, Server } from "lucide-react";

interface InfoModalProps {
  onClose: () => void;
}

const TTL_DAYS = 30; // mirrors config.anonymousTTLDays on the server

export function InfoModal({ onClose }: InfoModalProps) {
  return (
    <div
      className="fixed inset-0 z-modal flex items-end bg-ink/40 p-4 md:items-center md:justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-card border border-rule bg-paper p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="How ddrive works"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink">How ddrive works</h2>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors duration-short hover:bg-paper-2 hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <ul className="space-y-4 text-sm text-muted">
          <li className="flex gap-3">
            <UserX size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="font-medium text-ink">No account needed</p>
              <p>
                You can upload and share files without registering. Your files are tied to this
                browser only — open ddrive in a different browser or device and you won&rsquo;t see them.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <Clock size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="font-medium text-ink">Files auto-expire after {TTL_DAYS} days</p>
              <p>
                Every anonymous file is permanently deleted after {TTL_DAYS} days. We don&rsquo;t
                keep backups of expired files, so download anything important in time.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <Server size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="font-medium text-ink">Stored on Discord</p>
              <p>
                Files are chunked and stored using Discord as the storage backend. This keeps the
                service simple and free to use.
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="font-medium text-ink">Encryption &amp; privacy</p>
              <p>
                Uploaded chunks are encrypted before they leave your browser. Share links contain
                the key needed to decrypt, so only people with the link can view the file.
              </p>
            </div>
          </li>
        </ul>

        <div className="mt-6 rounded-md border border-rule-2 bg-paper-2 p-3 text-xs leading-relaxed text-muted">
          <strong className="text-ink">Privacy disclaimer:</strong> ddrive is a temporary file
          sharing tool. Do not upload anything you consider highly sensitive or that you cannot
          afford to lose. Anonymous files are not tied to an account and cannot be recovered if
          the link is lost or the file expires. Create an account to keep files permanently and
          manage them across devices.
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short hover:bg-accent-2"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
