import { useState } from "react";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass } from "../components/layout/AuthCard.js";
import type { LoginResponse } from "@ddv4/types/api";

const LOGIN_MUTATION = `
  mutation Login($emailOrUsername: String!, $password: String!) {
    login(emailOrUsername: $emailOrUsername, password: $password) {
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

export function Unlock() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const logout = useAuthStore((s) => s.logout);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError("");
    setLoading(true);

    try {
      const { login } = await gqlRequest<{ login: LoginResponse }>(LOGIN_MUTATION, {
        emailOrUsername: user.email,
        password,
      });

      if (!login.token || !login.user) {
        setError("Unlock failed. Please try again.");
        return;
      }
      setAuth(login.token, login.user);
    } catch {
      setError("Wrong password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="ddrive" subtitle="Enter your password to unlock the session.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={authLabelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            className={authInputClass}
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      <button
        onClick={logout}
        className="mt-4 w-full rounded-md py-2 text-sm text-muted transition-colors duration-short ease-out hover:text-ink-2"
      >
        Log out
      </button>
    </AuthCard>
  );
}
