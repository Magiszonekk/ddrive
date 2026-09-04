import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { humanizeVerifyError } from "../lib/auth-errors.js";
import { useAuthStore } from "../stores/auth.js";
import { AuthCard, authPrimaryButtonClass, authSecondaryButtonClass } from "../components/layout/AuthCard.js";
import type { LoginResponse } from "@ddv4/types/api";

const VERIFY_MUTATION = `
  mutation VerifyEmail($token: String!) {
    verifyEmail(token: $token) {
      requiresEmailVerification
      email
      token
      user {
        id
        email
        username
      }
    }
  }
`;

type Status = "pending" | "success" | "error";

export function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = params.get("token") ?? "";

  const [status, setStatus] = useState<Status>("pending");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Missing verification token. Open the link from your email.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { verifyEmail } = await gqlRequest<{ verifyEmail: LoginResponse }>(VERIFY_MUTATION, { token });
        if (cancelled) return;
        if (!verifyEmail.token || !verifyEmail.user) {
          setStatus("error");
          setError("Verification returned no session. Please sign in manually.");
          return;
        }
        setAuth(verifyEmail.token, verifyEmail.user);
        setStatus("success");
        // Give the user a moment to read the success message, then redirect.
        setTimeout(() => navigate("/", { replace: true }), 1500);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(humanizeVerifyError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [token, setAuth, navigate]);

  return (
    <AuthCard
      title={status === "success" ? "Email confirmed" : status === "error" ? "Verification failed" : "Verifying…"}
    >
      {status === "pending" && (
        <p className="text-sm text-muted">Hold on, we're confirming your email address…</p>
      )}
      {status === "success" && (
        <p className="text-sm text-ink-2">
          Your email is confirmed. You're signed in — taking you to your dashboard…
        </p>
      )}
      {status === "error" && (
        <>
          <p className="text-sm text-error">{error}</p>
          <Link to="/login" className={authPrimaryButtonClass}>
            Back to sign in
          </Link>
        </>
      )}
      {status !== "error" && (
        <Link to="/" className={authSecondaryButtonClass}>Skip</Link>
      )}
    </AuthCard>
  );
}
