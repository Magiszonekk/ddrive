import { useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { AuthCard, authPrimaryButtonClass, authSecondaryButtonClass } from "../components/layout/AuthCard.js";

const CONFIRM_DELETE_MUTATION = `
  mutation ConfirmAccountDeletion($token: String!) {
    confirmAccountDeletion(token: $token)
  }
`;

type Status = "confirming" | "deleting" | "done" | "error";

export function ConfirmDeleteAccount() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const token = params.get("token") ?? "";

  const [status, setStatus] = useState<Status>("confirming");
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    if (!token) {
      setStatus("error");
      setError("Missing deletion token. Open the link from your email.");
      return;
    }
    setStatus("deleting");
    setError("");
    try {
      await gqlRequest(CONFIRM_DELETE_MUTATION, { token });
      setStatus("done");
      logout();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not delete your account. The link may be invalid or expired.");
    }
  };

  if (status === "done") {
    return (
      <AuthCard title="Account deleted">
        <p className="text-sm text-ink-2">
          Your ddrive account and everything in it have been permanently deleted. Thanks for
          trying ddrive — we'll miss you.
        </p>
        <Link to="/" className={authPrimaryButtonClass}>Back to home</Link>
      </AuthCard>
    );
  }

  if (status === "error") {
    return (
      <AuthCard title="Something went wrong">
        <p className="text-sm text-error">{error}</p>
        <Link to="/app/settings" className={authPrimaryButtonClass}>Back to settings</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Delete your account?">
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          This is the final step. Clicking the button below <strong>permanently deletes</strong>{" "}
          your account, all your files, folders, share links, sessions and API keys. This cannot
          be undone.
        </p>
        <p className="text-sm text-muted">Changed your mind? Just close this page — nothing happens unless you click below.</p>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={status === "deleting"}
          className="flex h-11 w-full items-center justify-center rounded-md bg-error px-4 text-sm font-medium text-error-ink transition-colors duration-short ease-out hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "deleting" ? "Deleting…" : "Yes, permanently delete my account"}
        </button>
        <Link to="/" className={authSecondaryButtonClass}>Cancel, keep my account</Link>
      </div>
    </AuthCard>
  );
}
