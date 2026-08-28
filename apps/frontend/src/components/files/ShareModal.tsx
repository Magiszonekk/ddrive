import { useEffect, useState } from "react";
import { Check, Copy, Link2, ShieldX, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { authInputClass, authLabelClass, authPrimaryButtonClass } from "../layout/AuthCard.js";

const CREATE_SHARE = `
  mutation CreateShare(
    $fileId: ID!
    $allowContent: Boolean!
    $allowPreview: Boolean
    $expiresAt: String
    $maxViews: Int
  ) {
    createShare(
      fileId: $fileId
      allowContent: $allowContent
      allowPreview: $allowPreview
      expiresAt: $expiresAt
      maxViews: $maxViews
    ) {
      shareId
      token
    }
  }
`;

const SHARES_QUERY = `
  query Shares($fileId: ID!) {
    shares(fileId: $fileId) {
      shareId
      status
      expiresAt
      maxViews
      viewCount
      createdAt
    }
  }
`;

const LIST_ANON_SHARES = `
  query ListAnonShares($anonSessionId: String!) {
    listAnonymousShares(anonSessionId: $anonSessionId) {
      shareId
      shareType
      status
      expiresAt
      maxViews
      viewCount
      createdAt
      token
      label
    }
  }
`;

const REVOKE_SHARE = `
  mutation RevokeShare($shareId: ID!) {
    revokeShare(shareId: $shareId)
  }
`;

const REVOKE_ANON_SHARE = `
  mutation RevokeAnonShare($shareId: ID!, $anonSessionId: String!) {
    revokeAnonymousShare(shareId: $shareId, anonSessionId: $anonSessionId)
  }
`;

const CREATE_ANON_SHARE = `
  mutation CreateAnonShare($fileId: ID!, $allowContent: Boolean!, $allowPreview: Boolean, $expiresAt: String, $maxViews: Int, $anonSessionId: String, $label: String) {
    createAnonymousShare(fileId: $fileId, allowContent: $allowContent, allowPreview: $allowPreview, expiresAt: $expiresAt, maxViews: $maxViews, anonSessionId: $anonSessionId, label: $label) {
      shareId
      token
    }
  }
`;

const CREATE_ANON_FOLDER_SHARE = `
  mutation CreateAnonFolderShare($folderId: ID!, $allowContent: Boolean!, $allowPreview: Boolean, $expiresAt: String, $maxViews: Int, $anonSessionId: String, $label: String) {
    createAnonymousFolderShare(folderId: $folderId, allowContent: $allowContent, allowPreview: $allowPreview, expiresAt: $expiresAt, maxViews: $maxViews, anonSessionId: $anonSessionId, label: $label) {
      shareId
      token
    }
  }
`;

interface Props {
  file: {
    id: string;
    name?: string;
  };
  /** Folder id — when set, mints a folder share (anon) instead of a file share. */
  folderId?: string;
  onClose: () => void;
  /** When set, the modal uses the no-auth anonymous share mutation instead of the authed one. */
  anonSessionId?: string;
}

interface ShareItem {
  shareId: string;
  shareType?: string;
  status: string;
  expiresAt?: string | null;
  maxViews?: number | null;
  viewCount: number;
  createdAt: string;
  token?: string | null;
  label?: string | null;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function statusLabel(status: string, expiresAt?: string | null): string {
  if (status === "REVOKED") return "Revoked";
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return "Expired";
  return "Active";
}

function statusChipClass(label: string): string {
  if (label === "Active") return "chip chip--success";
  if (label === "Revoked" || label === "Expired") return "chip chip--error";
  return "chip";
}

export function ShareModal({ file, folderId, onClose, anonSessionId }: Props) {
  const [expiresAt, setExpiresAt] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyShare = (shareId: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(shareId);
    setTimeout(() => setCopiedId((cur) => (cur === shareId ? null : cur)), 2000);
  };

  const loadShares = async () => {
    setLoadingShares(true);
    try {
      if (anonSessionId) {
        const result = await gqlRequest<{ listAnonymousShares: ShareItem[] }>(LIST_ANON_SHARES, {
          anonSessionId,
        });
        setShares(result.listAnonymousShares ?? []);
      } else {
        const result = await gqlRequest<{ shares: ShareItem[] }>(SHARES_QUERY, { fileId: file.id });
        setShares(result.shares ?? []);
      }
    } catch (err) {
      console.error("Failed to load shares:", err);
    } finally {
      setLoadingShares(false);
    }
  };

  const loadSharesRef = loadShares;
  useEffect(() => { void loadSharesRef(); }, [file.id]);

  const handleCreate = async () => {
    setLoading(true);
    setError("");

    try {
      let shareUrl: string;
      if (folderId && anonSessionId) {
        const { createAnonymousFolderShare } = await gqlRequest<{ createAnonymousFolderShare: { shareId: string; token: string } }>(
          CREATE_ANON_FOLDER_SHARE,
          {
            folderId,
            allowContent: true,
            allowPreview: true,
            expiresAt: expiresAt || null,
            maxViews: maxViews ? Number(maxViews) : null,
            anonSessionId,
            label: label.trim() || null,
          },
        );
        shareUrl = `${window.location.origin}/s/${createAnonymousFolderShare.shareId}?t=${createAnonymousFolderShare.token}`;
      } else if (anonSessionId) {
        const { createAnonymousShare } = await gqlRequest<{ createAnonymousShare: { shareId: string; token: string } }>(
          CREATE_ANON_SHARE,
          {
            fileId: file.id,
            allowContent: true,
            allowPreview: true,
            expiresAt: expiresAt || null,
            maxViews: maxViews ? Number(maxViews) : null,
            anonSessionId,
            label: label.trim() || null,
          },
        );
        shareUrl = `${window.location.origin}/s/${createAnonymousShare.shareId}?t=${createAnonymousShare.token}`;
      } else {
        const { createShare } = await gqlRequest<{ createShare: { shareId: string; token: string } }>(CREATE_SHARE, {
          fileId: file.id,
          allowContent: true,
          allowPreview: true,
          expiresAt: expiresAt || null,
          maxViews: maxViews ? Number(maxViews) : null,
        });
        shareUrl = `${window.location.origin}/s/${createShare.shareId}?t=${createShare.token}`;
      }

      setShareUrl(shareUrl);
      // Refresh the list so the new link appears immediately
      void loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create share link");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async (shareId: string) => {
    setRevokingShareId(shareId);
    try {
      if (anonSessionId) {
        await gqlRequest(REVOKE_ANON_SHARE, { shareId, anonSessionId });
      } else {
        await gqlRequest(REVOKE_SHARE, { shareId });
      }
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke share link");
    } finally {
      setRevokingShareId(null);
    }
  };

  // In the simplified (default) view we hide expired shares entirely; in
  // details view we keep them visible so the user can spot/revoke them.
  const isExpired = (s: ShareItem) => statusLabel(s.status, s.expiresAt) === "Expired";
  const visibleShares = shares.filter((s) => showDetails || !isExpired(s));

  return (
    <div className="fixed inset-0 z-modal flex items-end bg-ink/40 md:items-center md:justify-center">
      <div className="w-full rounded-t-card border border-rule bg-paper p-5 pb-6 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)] md:max-w-2xl md:rounded-card md:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="truncate font-display text-base font-semibold text-ink">Share "{file.name ?? file.id}"</h2>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-muted transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <h3 className="mb-3 text-sm font-medium text-ink">Create new share link</h3>
              <div className="space-y-4 rounded-md bg-paper-2 p-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                  <input
                    type="checkbox"
                    checked={showAdvanced}
                    onChange={(e) => setShowAdvanced(e.target.checked)}
                    className="h-4 w-4 rounded border-rule-2 text-accent focus:ring-accent"
                  />
                  Advanced options
                </label>
                {showAdvanced && (
                  <>
                    <div>
                      <label className={authLabelClass}>
                        Name <span className="font-normal text-muted">(optional, for your reference)</span>
                      </label>
                      <input
                        type="text"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="e.g. Photos for mom"
                        className={authInputClass}
                      />
                    </div>
                    <div>
                      <label className={authLabelClass}>
                        Expires <span className="font-normal text-muted">(optional)</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                        className={authInputClass}
                      />
                    </div>
                    <div>
                      <label className={authLabelClass}>
                        Max views <span className="font-normal text-muted">(optional)</span>
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={maxViews}
                        onChange={(e) => setMaxViews(e.target.value)}
                        className={authInputClass}
                      />
                    </div>
                  </>
                )}
                {error && <p className="text-sm text-error">{error}</p>}
                <button onClick={handleCreate} disabled={loading} className={authPrimaryButtonClass}>
                  {loading ? "Creating…" : "Create share link"}
                </button>
              </div>
            </div>

            {shareUrl && (
              <div className="space-y-3 rounded-md border-l-2 border-success bg-success/5 p-4">
                <p className="text-sm text-ink-2">
                  Link created — copy it now, it won't be shown again.
                </p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 rounded-md border border-rule-2 bg-paper-2 px-3 py-3 font-mono text-xs text-ink-2 focus:outline-none"
                  />
                  <button
                    onClick={handleCopy}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-3 py-3 text-xs font-medium text-ink-2 transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
                  >
                    {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink">Existing share links</h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted transition-colors duration-micro ease-out hover:text-ink-2">
                <input
                  type="checkbox"
                  checked={showDetails}
                  onChange={(e) => setShowDetails(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-rule-2 text-accent focus:ring-accent"
                />
                Show details
              </label>
            </div>
            <div className="rounded-md bg-paper-2 p-4">
              {loadingShares ? (
                <p className="text-sm text-muted">Loading shares…</p>
              ) : visibleShares.length === 0 ? (
                <p className="text-sm text-muted">No share links yet.</p>
              ) : (
                <div className="max-h-88 divide-y divide-rule overflow-y-auto pr-0.5">
                  {[...visibleShares]
                    .sort((a, b) => {
                      const aActive = statusLabel(a.status, a.expiresAt) === "Active";
                      const bActive = statusLabel(b.status, b.expiresAt) === "Active";
                      return aActive === bActive ? 0 : aActive ? -1 : 1;
                    })
                    .map((share) => {
                      const label = statusLabel(share.status, share.expiresAt);
                      const active = label === "Active";
                      const shareUrl = share.token
                        ? `${window.location.origin}/s/${share.shareId}?t=${share.token}`
                        : null;
                      const rowCopied = copiedId === share.shareId;
                      return (
                        <div key={share.shareId} className="py-3 first:pt-0 last:pb-0">
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm text-ink">
                                <Link2 size={14} className="shrink-0 text-muted" />
                                <span className="truncate">
                                  {share.label ? share.label : (share.shareType === "FOLDER" ? "Folder" : file.name ?? "Shared file")}
                                </span>
                              </div>
                              {showDetails && (
                                <div className="mt-1 font-mono text-xs tabular-nums text-muted">
                                  {share.shareId}
                                </div>
                              )}
                            </div>
                            {showDetails && (
                              <span className={statusChipClass(label)}>{label}</span>
                            )}
                          </div>
                          {showDetails && (
                            <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                              <div>
                                Expires:{" "}
                                <span className="font-mono tabular-nums text-ink-2">{formatDate(share.expiresAt)}</span>
                              </div>
                              <div>
                                Views:{" "}
                                <span className="font-mono tabular-nums text-ink-2">
                                  {share.viewCount}
                                  {share.maxViews ? ` / ${share.maxViews}` : ""}
                                </span>
                              </div>
                            </div>
                          )}
                          <div className="mt-3 flex justify-end gap-2">
                            {shareUrl && (
                              <button
                                onClick={() => copyShare(share.shareId, shareUrl)}
                                className="inline-flex items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-3 py-2 text-xs font-medium text-ink-2 transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
                              >
                                {rowCopied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                                {rowCopied ? "Copied" : "Copy link"}
                              </button>
                            )}
                            <button
                              onClick={() => handleRevoke(share.shareId)}
                              disabled={!active || revokingShareId === share.shareId}
                              className="inline-flex items-center gap-2 rounded-md border border-error px-3 py-2 text-xs font-medium text-error transition-colors duration-micro ease-out hover:bg-error hover:text-error-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-error"
                            >
                              <ShieldX size={14} />
                              {revokingShareId === share.shareId ? "Revoking…" : "Revoke"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
