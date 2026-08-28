# Forgot / Reset Password (email) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let a logged-out user request a password reset email and set a new
password via a time-limited token link, using a generic SMTP mailer.

**Architecture:** Add two Prisma columns to `User` (hashed reset token +
expiry). A new SMTP mailer module (reads `SMTP_*` env, with a dev console-log
fallback when unconfigured) sends a link containing a raw token. Two new GraphQL
mutations (`requestPasswordReset`, `resetPassword`) live in the existing
`auth` resolver module. The reset token follows the same `randomBytes(32)` +
sha256-hash-to-DB pattern already used for refresh tokens. On successful reset
we revoke all device sessions for that user (security). Frontend adds two pages
(`/forgot-password`, `/reset-password`) reusing the existing `AuthCard` + confirm
password pattern. No deployment is in scope for this plan (build + typecheck only).

**Tech Stack:** TypeScript (Node), graphql-yoga, Prisma + PostgreSQL, nodemailer,
React (existing `apps/frontend`).

---

## Current state (verified in repo)

- `apps/api/src/resolvers/auth.ts` — `hashPassword` is `sha256` **without salt**
  (TODO argon2id at line 14). Token pattern `randomBytes(32).toString("base64url")`
  + `hashRefreshToken` (sha256) is the model to copy for reset tokens.
- `packages/database/prisma/schema.prisma` — `User` has no reset fields (only
  `passwordHash`). Must migrate.
- `apps/api/src/middleware/rate-limit.ts` — `auth` policy (10 req/min) exists;
  `enforceRateLimit(ip, "auth")` is the call to wrap `requestPasswordReset`.
- `apps/api/src/schema.ts` — `Context` exposes `ip: string` (line 14) and
  `requireAuth`/`requireInteractive` helpers. Mutations are registered in the
  `Mutation` type + resolver map.
- `packages/config/src/server.ts` — `serverConfig` reads env; add SMTP keys here.
- Frontend: `apps/frontend/src/pages/Register.tsx` already has a
  `confirmPassword` field + `authInputClass`/`authLabelClass` from
  `components/layout/AuthCard.js`. `App.tsx` defines `<Route>`s.
- **No mailer exists anywhere** — this is the only net-new infra dependency.

---

## Task 1: Add SMTP config to server config

**Objective:** Centralize SMTP env vars so the mailer and reset resolvers can
read them.

**Files:**
- Modify: `packages/config/src/server.ts` (add to `serverConfig` object)

**Step 1: Add SMTP fields to `serverConfig`**

Append inside the `serverConfig = { ... }` object (after `frontendUrl`, ~line 114):

```ts
  smtp: {
    host: process.env.SMTP_HOST?.trim() ?? "",
    port: parseInt(process.env.SMTP_PORT ?? "587", 10),
    secure: (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true",
    user: process.env.SMTP_USER?.trim() ?? "",
    pass: process.env.SMTP_PASS?.trim() ?? "",
    from: process.env.MAIL_FROM?.trim() ?? "noreply@ddrive.local",
  },
```

**Step 2: Typecheck**

Run: `cd /home/ubuntu/Desktop/ddrive-work/target && npm run typecheck`
Expected: passes (no new errors).

**Step 3: Commit**

```bash
git add packages/config/src/server.ts
git commit -m "config: add SMTP settings from env"
```

---

## Task 2: Create the mailer module

**Objective:** Send a transactional email via SMTP, or log the link to console
when SMTP is unconfigured (dev fallback) so the flow is testable without creds.

**Files:**
- Create: `apps/api/src/lib/mailer.ts`
- Modify: `apps/api/package.json` (add `nodemailer` + `@types/nodemailer` devDep)

**Step 1: Add dependency**

In `apps/api/package.json` add to `dependencies`:
```json
"nodemailer": "^6.9.0"
```
and install: `cd /home/ubuntu/Desktop/ddrive-work/target && npm install` (or
`npm install -w apps/api nodemailer`).

**Step 2: Write the module**

`apps/api/src/lib/mailer.ts`:

```ts
import nodemailer from "nodemailer";
import { serverConfig } from "@ddv4/config/server";

const cfg = serverConfig.smtp;

function buildTransport() {
  // Lazily created so import never throws when SMTP is absent.
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  resetLink: string,
): Promise<void> {
  const subject = "ddrive — reset your password";
  const text =
    `We received a request to reset your ddrive password.\n\n` +
    `Click the link below to choose a new password. This link expires in 1 hour.\n\n` +
    `${resetLink}\n\n` +
    `If you did not request this, you can ignore this email.`;

  // Dev fallback: no SMTP configured → log the link instead of sending.
  if (!cfg.host) {
    console.log(`[mailer:dev] password reset link for ${to}:\n${resetLink}`);
    return;
  }

  const transport = buildTransport();
  await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
  });
}
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes.

**Step 4: Commit**

```bash
git add apps/api/src/lib/mailer.ts apps/api/package.json package-lock.json
git commit -m "feat: add SMTP mailer with dev console fallback"
```

---

## Task 3: Prisma schema — reset token columns

**Objective:** Persist the reset token (hashed) and its expiry on `User`.

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (`User` model, ~line 10)

**Step 1: Add columns**

After `passwordHash String` (line 14) in `model User`, add:

```prisma
  passwordResetToken   String?   @unique
  passwordResetExpires DateTime?
```

**Step 2: Generate + apply migration**

Run:
```bash
cd /home/ubuntu/Desktop/ddrive-work/target
npm run db:generate
npm run db:migrate   # or: npx prisma migrate dev --name add_password_reset
```
Expected: migration created and applied; client regenerated.

> If the project uses `prisma db push` instead of migrate in this repo, run
> `npx prisma db push` after `db:generate`. Check `package.json` scripts first.

**Step 3: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "db: add password reset token columns to User"
```

---

## Task 4: Auth resolvers — request + reset

**Objective:** Implement the two GraphQL mutations with rate limiting, generic
responses (no account enumeration), and session revocation on reset.

**Files:**
- Modify: `apps/api/src/resolvers/auth.ts`

**Step 1: Add helpers + imports**

At top of `auth.ts` add imports:
```ts
import { sendPasswordResetEmail } from "../lib/mailer.js";
import { enforceRateLimit } from "../middleware/rate-limit.js";
import { randomBytes } from "node:crypto"; // already imported? add if missing
```
Note: `randomBytes` and `createHash` are already imported at line 3.

Add a hash helper (mirror `hashRefreshToken`):
```ts
function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

**Step 2: Implement `requestPasswordReset`**

```ts
export async function requestPasswordReset(email: string, ip: string): Promise<boolean> {
  enforceRateLimit(ip, "auth");

  // Generic success: always return true even if no user, to avoid enumeration.
  const user = await db.user.findUnique({ where: { email } });
  if (user) {
    const rawToken = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await db.user.update({
      where: { id: user.id },
      data: { passwordResetToken: hashResetToken(rawToken), passwordResetExpires: expires },
    });
    const link = `${serverConfig.frontendUrl}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, link);
  }
  return true;
}
```

> Note: `serverConfig` must be imported in `auth.ts` if not already
> (`import { serverConfig } from "@ddv4/config/server";`). Check existing imports.

**Step 3: Implement `resetPassword`**

```ts
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<boolean> {
  const user = await db.user.findFirst({
    where: {
      passwordResetToken: hashResetToken(token),
      passwordResetExpires: { gt: new Date() },
    },
  });
  if (!user) throw new Error("Invalid or expired reset token");

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(newPassword),
      passwordResetToken: null,
      passwordResetExpires: null,
    },
  });

  // Security: revoke all device sessions so a stolen session is killed too.
  const sessions = await db.deviceSession.findMany({
    where: { userId: user.id, revokedAt: null },
  });
  for (const s of sessions) {
    await db.deviceSession.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    invalidateSessionCache(s.id);
  }
  return true;
}
```

> **Consistency note:** `Register` currently validates password length
> (`>= 8`) and match only on the frontend, not in the resolver. To stay
> consistent, `resetPassword` here also does NOT re-check length — the frontend
> enforces it (mirrors Register). If you want a backend guard too, add
> `if (newPassword.length < 8) throw new Error("Password must be at least 8 characters");`
> before the update. Decide per project policy; flag if divergent from Register.

**Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/auth.ts
git commit -m "feat: requestPasswordReset + resetPassword resolvers"
```

---

## Task 5: Wire resolvers into GraphQL schema

**Objective:** Expose the two mutations in `schema.ts` (type def + resolver map).

**Files:**
- Modify: `apps/api/src/schema.ts`

**Step 1: Add to `Mutation` type**

Inside the `Mutation { ... }` block (near `changePassword`, ~line 299), add:

```graphql
        requestPasswordReset(email: String!): Boolean!
        resetPassword(token: String!, newPassword: String!): Boolean!
```

**Step 2: Add to resolver map**

In the resolver map where `changePassword` / `login` are wired (search for
`changePassword: async`), add:

```ts
        requestPasswordReset: async (
          _p: unknown,
          args: { email: string },
          ctx: Context,
        ) => authResolvers.requestPasswordReset(args.email, ctx.ip),

        resetPassword: async (
          _p: unknown,
          args: { token: string; newPassword: string },
          _ctx: Context,
        ) => authResolvers.resetPassword(args.token, args.newPassword),
```

**Step 3: Typecheck**

Run: `npm run typecheck`
Expected: passes.

**Step 4: Commit**

```bash
git add apps/api/src/schema.ts
git commit -m "api: expose requestPasswordReset + resetPassword mutations"
```

---

## Task 6: Frontend — Forgot password page

**Objective:** A page where the user submits their email; always shows a generic
confirmation regardless of whether the account exists.

**Files:**
- Create: `apps/frontend/src/pages/ForgotPassword.tsx`
- Modify: `apps/frontend/src/App.tsx` (add route)

**Step 1: Add GraphQL mutation constant + page**

`ForgotPassword.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass } from "../components/layout/AuthCard.js";

const REQUEST_RESET = `
  mutation RequestPasswordReset($email: String!) {
    requestPasswordReset(email: $email)
  }
`;

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await gqlRequest(REQUEST_RESET, { email });
      setDone(true); // generic success — no enumeration
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="Reset password"
      footer={
        <>
          Remembered it?{" "}
          <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {done ? (
        <p className="text-sm text-success">
          If an account exists for that email, we've sent a reset link. Check your inbox.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={authLabelClass}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={authInputClass}
            />
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
          <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
```

**Step 2: Register route in `App.tsx`**

Import `ForgotPassword` (next to `Register` import at line 4) and add a route
inside the `<Routes>` block, near the `/register` route (line 41):

```tsx
<Route path="/forgot-password" element={<ForgotPassword />} />
```

Also add a "Forgot password?" link on the Login page (`apps/frontend/src/pages/Login.tsx`)
pointing to `/forgot-password` (optional but expected UX).

**Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: passes.

**Step 4: Commit**

```bash
git add apps/frontend/src/pages/ForgotPassword.tsx apps/frontend/src/App.tsx apps/frontend/src/pages/Login.tsx
git commit -m "feat: forgot-password page"
```

---

## Task 7: Frontend — Reset password page

**Objective:** Page reached from the email link; reads `token` from the URL query
and lets the user set a new password (with confirm field, reusing Register's pattern).

**Files:**
- Create: `apps/frontend/src/pages/ResetPassword.tsx`
- Modify: `apps/frontend/src/App.tsx` (add route)

**Step 1: Add GraphQL mutation + page**

`ResetPassword.tsx`:

```tsx
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
            <p className="text-sm text-error">Missing or invalid reset link.</p>
          )}
          <div>
            <label className={authLabelClass}>New password</label>
            <input type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} required
              className={authInputClass} />
          </div>
          <div>
            <label className={authLabelClass}>Confirm password</label>
            <input type="password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)} required
              className={authInputClass} />
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
```

**Step 2: Register route in `App.tsx`**

```tsx
<Route path="/reset-password" element={<ResetPassword />} />
```

**Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: passes.

**Step 4: Commit**

```bash
git add apps/frontend/src/pages/ResetPassword.tsx apps/frontend/src/App.tsx
git commit -m "feat: reset-password page with confirm field"
```

---

## Task 8: End-to-end verification (local, no creds)

**Objective:** Prove the flow works against a local/dev DB using the dev mailer
fallback (console log) — no SMTP credentials required.

**Files:**
- Test: `apps/api/src/__tests__/integration/password-reset.integration.test.ts`

**Step 1: Write an integration test** (mirrors `core-v1-smoke.integration.test.ts`)

Cover:
1. Register a user → request reset → assert mutation returns `true`.
2. Capture the reset link from `console.log` (spy on `console.log`, or call
   `requestPasswordReset` directly and read the token from the DB in the test).
3. Call `resetPassword(token, "NewPass123!")` → assert `true`.
4. Login with the new password succeeds; login with the old password fails.
5. Assert all device sessions were revoked (DB check on `deviceSession.revokedAt`).
6. Re-use of the same token fails (single-use: token cleared after reset).

**Step 2: Run the test**

Run: `npm run test -- password-reset` (or the project's test runner)
Expected: all assertions pass.

> If no test runner is configured for `.integration.test.ts`, add a script or
> run via `tsx`/`vitest` consistently with the existing smoke test.

**Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/password-reset.integration.test.ts
git commit -m "test: password reset flow integration test"
```

---

## Validation summary

- `npm run typecheck` — clean after every task.
- `npm run build` — frontend builds after Tasks 6–7.
- `npm run test -- password-reset` — full round-trip passes (Task 8).
- Manual dev check: with `SMTP_HOST` unset, the reset link is printed to the API
  console; paste it into the browser at `/reset-password?token=…` and confirm the
  password change works and old password is rejected.

## Risks / tradeoffs / open questions

- **sha256 without salt for passwords** (pre-existing, `hashPassword`): reset
  does not fix this. Recommend a follow-up to migrate to argon2id (the existing
  TODO at `auth.ts:14`) — out of scope here but worth flagging to the user.
- **Dev mailer fallback only logs** the link — fine for local, but prod MUST set
  `SMTP_*` env or resets silently no-op (email never delivered). Document this in
  the deploy runbook / `.env.example`.
- **Rate limit policy** uses the shared `auth` bucket (10 req/min/IP). On a busy
  instance this also covers login/register; acceptable. If reset volume is a
  concern, add a dedicated `passwordReset` policy.
- **Token single-use + 1h expiry** is enforced; `resetPassword` clears the token.
- **No email verification on register** is out of scope (separate feature).
- **Deployment to prod** (OVH `.env` SMTP keys + `git pull` + rebuild + restart)
  is intentionally NOT in this plan — user chose plan-only.

## Files likely to change (recap)

- `packages/config/src/server.ts` — SMTP config
- `apps/api/package.json` — nodemailer dep
- `apps/api/src/lib/mailer.ts` — NEW
- `packages/database/prisma/schema.prisma` — User reset columns + migration
- `apps/api/src/resolvers/auth.ts` — two resolvers + hash helper
- `apps/api/src/schema.ts` — Mutation type + resolver wiring
- `apps/frontend/src/pages/ForgotPassword.tsx` — NEW
- `apps/frontend/src/pages/ResetPassword.tsx` — NEW
- `apps/frontend/src/App.tsx` — two routes
- `apps/frontend/src/pages/Login.tsx` — "forgot?" link (optional)
- `apps/api/src/__tests__/integration/password-reset.integration.test.ts` — NEW
