// ddrive v4 — Auth resolvers

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { db } from "@ddv4/database";
import {
  signToken,
  invalidateSessionCache,
  invalidateApiKeyCache,
  hashApiKeyAuthPart,
} from "../middleware/auth.js";
import { enforceRateLimit } from "../middleware/rate-limit.js";
import { serverConfig } from "@ddv4/config/server";
import { sendPasswordResetEmail, sendVerificationEmail, sendAccountDeletionEmail } from "../lib/mailer.js";
import type { RegisterRequest, RegisterResponse, LoginResponse } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DELETE_ACCOUNT_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function hashVerifyToken(token: string): string {
  return hashResetToken(token);
}
function hashDeletionToken(token: string): string {
  return hashResetToken(token);
}
// Password hashing: argon2id with per-password salt (argon2 bakes the salt
// into the encoded $argon2id$... string, so no separate salt column is needed).
//
// Backward compatibility: accounts created before this change store a raw
// 64-char lowercase hex sha256(password) digest (no salt). `verifyPassword`
// accepts both forms and, on a successful legacy login, transparently
// re-hashes the password with argon2 (lazy migration) so old hashes don't
// linger forever. New passwords are always stored as argon2.
const LEGACY_SHA256_RE = /^[0-9a-f]{64}$/;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (LEGACY_SHA256_RE.test(hash)) {
    // Old unsalted sha256 digest.
    const presented = Buffer.from(createHash("sha256").update(password).digest("hex"), "hex");
    const stored = Buffer.from(hash, "hex");
    if (presented.length !== stored.length) return false;
    return timingSafeEqual(presented, stored);
  }
  // argon2 encoded hash (or anything unrecognised) — defer to argon2, which
  // throws on malformed input; treat that as a failed verification.
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

const SESSION_REFRESH_TTL_DAYS = 180;
const SESSION_ACCESS_TOKEN_TTL = "1h";

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createDeviceSession(
  userId: string,
  email: string,
  deviceName: string,
): Promise<{ token: string; refreshToken: string }> {
  const refreshToken = randomBytes(32).toString("base64url");
  const session = await db.deviceSession.create({
    data: {
      userId,
      deviceName,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + SESSION_REFRESH_TTL_DAYS * 86_400_000),
    },
  });

  const token = signToken({ userId, email, sid: session.id }, SESSION_ACCESS_TOKEN_TTL);
  return { token, refreshToken };
}

export async function refreshSession(refreshToken: string): Promise<{ token: string }> {
  const session = await db.deviceSession.findUnique({
    where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new Error("Invalid or expired session");
  }

  await db.deviceSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    token: signToken({ userId: session.userId, email: session.user.email, sid: session.id }, SESSION_ACCESS_TOKEN_TTL),
  };
}

export async function listSessions(userId: string) {
  return db.deviceSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
  });
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const session = await db.deviceSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Session not found");

  await db.deviceSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
  invalidateSessionCache(sessionId);
  return true;
}

export async function listApiKeys(userId: string) {
  return db.apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
}

export async function createApiKey(
  userId: string,
  input: {
    name: string;
    authPart: string;
    expiresAt?: string | null;
  },
) {
  const name = input.name.trim();
  if (!name) throw new Error("API key name is required");

  if (input.authPart.length < 43) throw new Error("API key secret is too short");

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Invalid expiresAt");
  if (expiresAt && expiresAt <= new Date()) throw new Error("expiresAt must be in the future");

  const created = await db.apiKey.create({
    data: {
      userId,
      name,
      keyHash: hashApiKeyAuthPart(input.authPart),
      prefix: input.authPart.slice(0, 8),
      expiresAt,
    },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });

  return created;
}

export async function revokeApiKey(userId: string, apiKeyId: string): Promise<boolean> {
  const key = await db.apiKey.findFirst({ where: { id: apiKeyId, userId } });
  if (!key) throw new Error("API key not found");

  await db.apiKey.update({
    where: { id: apiKeyId },
    data: { revokedAt: new Date() },
  });
  invalidateApiKeyCache(key.keyHash);
  return true;
}

export async function register(input: RegisterRequest): Promise<RegisterResponse> {
  const existingEmail = await db.user.findUnique({ where: { email: input.email } });
  if (existingEmail) throw new Error("Email already registered");

  const existingUsername = await db.user.findUnique({ where: { username: input.username } });
  if (existingUsername) throw new Error("Username already taken");

  const user = await db.user.create({
    data: {
      email: input.email,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      // New field — see prisma/schema.prisma. Existing rows from before the
      // migration default to false via Prisma's @default(false), which means
      // pre-migration accounts would be locked out — the deployment script
      // flips them to true before the new code rolls out. See notes in the
      // deploy plan.
      emailVerified: false,
    },
  });

  // Issue a verification token and email it. We do NOT issue a session
  // token here — the user cannot use ddrive until they click the link.
  const rawToken = randomBytes(32).toString("base64url");
  await db.emailVerification.create({
    data: {
      userId: user.id,
      tokenHash: hashVerifyToken(rawToken),
      expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });
  const link = `${serverConfig.frontendUrl.replace(/\/$/, "")}/verify-email?token=${rawToken}`;
  await sendVerificationEmail(user.email, link);

  await pluginRegistry.emitAsync("user:registered", { userId: user.id, email: user.email });

  return { requiresEmailVerification: true, email: user.email };
}

/**
 * Verifies the email token from the link clicked by the user, flips
 * emailVerified to true, and returns a session (login response). All
 * outstanding EmailVerification rows for this user are marked used in
 * the same transaction to prevent replay.
 */
export async function verifyEmail(token: string): Promise<LoginResponse> {
  const row = await db.emailVerification.findUnique({
    where: { tokenHash: hashVerifyToken(token) },
    include: { user: true },
  });
  if (!row) throw new Error("Invalid verification token");
  if (row.usedAt) throw new Error("Verification link already used");
  if (row.expiresAt < new Date()) throw new Error("Verification link expired");

  await db.$transaction([
    db.emailVerification.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    }),
    db.user.update({
      where: { id: row.userId },
      data: { emailVerified: true },
    }),
  ]);

  return {
    requiresEmailVerification: false as const,
    token: signToken({ userId: row.user.id, email: row.user.email }),
    user: {
      id: row.user.id,
      email: row.user.email,
      username: row.user.username,
    },
  };
}

/**
 * Generates a new verification token for an unverified account and emails
 * it. Always returns true (even if no such email exists) to avoid
 * account enumeration — same policy as requestPasswordReset.
 *
 * If the account is already verified, no mail is sent and no token is
 * generated.
 */
export async function resendVerification(email: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.emailVerified) return true;

  const rawToken = randomBytes(32).toString("base64url");
  await db.emailVerification.create({
    data: {
      userId: user.id,
      tokenHash: hashVerifyToken(rawToken),
      expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });
  const link = `${serverConfig.frontendUrl.replace(/\/$/, "")}/verify-email?token=${rawToken}`;
  await sendVerificationEmail(user.email, link);
  return true;
}

export async function login(
  emailOrUsername: string,
  password: string,
  deviceName?: string | null,
): Promise<LoginResponse> {
  const user = await db.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new Error("Invalid credentials");
  }

  // Block unverified accounts from signing in. They have to click the
  // verification link first (or request a new one via resendVerification).
  // Pre-migration accounts that pre-date the emailVerified column will
  // have it as false and need to be flipped in the deploy script.
  if (!user.emailVerified) {
    throw new Error("Email not verified");
  }

  // Lazy migration: if the stored hash is the legacy sha256 form, upgrade it
  // to argon2id on successful authentication (no extra user action needed).
  if (LEGACY_SHA256_RE.test(user.passwordHash)) {
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    }).catch(() => undefined); // best-effort; don't fail the login if it errors
  }

  let token: string;
  let refreshToken: string | undefined;
  if (deviceName?.trim()) {
    ({ token, refreshToken } = await createDeviceSession(user.id, user.email, deviceName.trim()));
  } else {
    token = signToken({ userId: user.id, email: user.email });
  }

  return {
    requiresEmailVerification: false as const,
    token,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new Error("Current password is incorrect");
  }

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  return true;
}

export async function requestPasswordReset(email: string, ip: string): Promise<boolean> {
  // Rate limiting is enforced at the schema layer (same policy as changePassword).
  // Generic response: always true, even if no such account, to avoid
  // leaking which emails are registered (account enumeration).
  const user = await db.user.findUnique({ where: { email } });
  if (user) {
    const rawToken = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashResetToken(rawToken),
        passwordResetExpires: expires,
      },
    });
    const link = `${serverConfig.frontendUrl}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, link);
  }
  return true;
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
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
      passwordHash: await hashPassword(newPassword),
      passwordResetToken: null,
      passwordResetExpires: null,
    },
  });

  // Security: revoke all device sessions so a stolen/older session is killed.
  const sessions = await db.deviceSession.findMany({
    where: { userId: user.id, revokedAt: null },
  });
  for (const s of sessions) {
    await db.deviceSession.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
    invalidateSessionCache(s.id);
  }

  return true;
}

/**
 * Step 1 of account deletion: the caller must be signed in (JWT session,
 * not an API key — see requireInteractive in schema.ts) and re-enter their
 * current password. On success, mints a deletion token and emails a
 * confirmation link. Nothing is deleted yet — see confirmAccountDeletion.
 *
 * Requiring the password here (in addition to the email link) mirrors
 * changePassword's re-auth requirement: a stolen/left-open session alone
 * isn't enough to destroy the account.
 */
export async function requestAccountDeletion(userId: string, currentPassword: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new Error("Current password is incorrect");
  }

  const rawToken = randomBytes(32).toString("base64url");
  await db.accountDeletion.create({
    data: {
      userId: user.id,
      tokenHash: hashDeletionToken(rawToken),
      expiresAt: new Date(Date.now() + DELETE_ACCOUNT_TOKEN_TTL_MS),
    },
  });
  const link = `${serverConfig.frontendUrl.replace(/\/$/, "")}/confirm-delete-account?token=${rawToken}`;
  await sendAccountDeletionEmail(user.email, user.username, link);

  return true;
}

/**
 * Step 2 of account deletion: the caller clicked the link from the email.
 * Deletes the user row, which cascades (onDelete: Cascade in
 * prisma/schema.prisma) to files, folders, blobTransport rows, shares,
 * device sessions, API keys, EmailVerification and AccountDeletion rows.
 *
 * This does NOT delete the underlying chunks from Discord/Telegram — only
 * the ddrive metadata. That's consistent with how the rest of ddrive treats
 * storage providers (see docs/hermes/concept.md).
 */
export async function confirmAccountDeletion(token: string): Promise<boolean> {
  const row = await db.accountDeletion.findUnique({
    where: { tokenHash: hashDeletionToken(token) },
  });
  if (!row) throw new Error("Invalid deletion token");
  if (row.usedAt) throw new Error("Deletion link already used");
  if (row.expiresAt < new Date()) throw new Error("Deletion link expired");

  // Mark used first, then delete the user (cascades everything else). If
  // the delete somehow fails, the token is still burned — that's the safer
  // failure mode for a destructive action (no silent retry with a stale link).
  await db.accountDeletion.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  await db.user.delete({ where: { id: row.userId } });

  return true;
}
