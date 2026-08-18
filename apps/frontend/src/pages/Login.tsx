import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass, authSecondaryButtonClass } from "../components/layout/AuthCard.js";
import type { LoginResponse } from "@ddv4/types/api";

const LOGIN_MUTATION = `
  mutation Login($emailOrUsername: String!, $password: String!) {
    login(emailOrUsername: $emailOrUsername, password: $password) {
      token
      user {
        id
        email
        username
      }
    }
  }
`;

export function Login() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { login } = await gqlRequest<{ login: LoginResponse }>(LOGIN_MUTATION, {
        emailOrUsername: identifier.trim(),
        password: password.trim(),
      });

      setAuth(login.token, login.user);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="ddrive"
      footer={
        <>
          Don&rsquo;t have an account?{" "}
          <Link to="/register" className="font-medium text-accent underline-offset-2 hover:underline">
            Register
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={authLabelClass}>Email or username</label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoComplete="username"
            className={authInputClass}
          />
        </div>
        <div>
          <label className={authLabelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={authInputClass}
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? "Logging in…" : "Log in"}
        </button>
        <Link to="/upload" className={authSecondaryButtonClass}>
          Continue without an account
        </Link>
      </form>
    </AuthCard>
  );
}
