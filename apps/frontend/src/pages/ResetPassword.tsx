import { useState } from "react";
import { useNavigate, Link, useSearchParams } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass } from "../components/layout/AuthCard.js";

const RESET = `
  mutation ResetPassword($token: String!, $newPassword: String!) {
    resetPassword(token: $token, newPassword: $newPassword)
  }
`;

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      await gqlRequest(RESET, { token, newPassword: password });
      setDone(true);
      setTimeout(() => navigate("/login"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <p className="text-sm text-success">Password updated. Redirecting to login…</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {!token && (
            <p className="text-sm text-error">This reset link is missing its token.</p>
          )}
          <div>
            <label className={authLabelClass}>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              className={authInputClass}
            />
          </div>
          <div>
            <label className={authLabelClass}>Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              className={authInputClass}
            />
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
          <button type="submit" disabled={loading || !token} className={authPrimaryButtonClass}>
            {loading ? "Updating…" : "Update password"}
          </button>
          <p className="text-sm">
            <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">
              Back to login
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
