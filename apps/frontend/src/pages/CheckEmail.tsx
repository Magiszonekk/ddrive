import { useState } from "react";
import { Link, useLocation } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { humanizeResendError } from "../lib/auth-errors.js";
import { AuthCard, authPrimaryButtonClass, authSecondaryButtonClass } from "../components/layout/AuthCard.js";

const RESEND_MUTATION = `
  mutation ResendVerification($email: String!) {
    resendVerification(email: $email)
  }
`;

export function CheckEmail() {
  const location = useLocation();
  const initialEmail = (location.state as { email?: string } | null)?.email ?? "";
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  const handleResend = async () => {
    if (!email) {
      setError("Please enter the email you used to sign up.");
      return;
    }
    setStatus("sending");
    setError("");
    try {
      await gqlRequest(RESEND_MUTATION, { email });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setError(humanizeResendError(err));
    }
  };

  return (
    <AuthCard title="Check your email" subtitle="We sent you a verification link.">
      <p className="text-sm text-muted">
        We sent a verification link to{" "}
        <strong className="text-ink-2">{email || "your email address"}</strong>. Click the
        link in the email to activate your account. The link expires in 24 hours.
      </p>
      {status === "sent" && (
        <p className="rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-ink-2">
          A new verification email is on its way. Check your inbox (and spam folder).
        </p>
      )}
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-ink-2">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-md border border-rule-2 bg-paper px-3 py-2 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out placeholder:text-muted focus:outline-focus"
        />
        <button
          type="button"
          onClick={handleResend}
          disabled={status === "sending"}
          className={authPrimaryButtonClass}
        >
          {status === "sending" ? "Sending…" : "Resend verification email"}
        </button>
      </div>
      <Link to="/login" className={authSecondaryButtonClass}>
        Back to sign in
      </Link>
    </AuthCard>
  );
}
