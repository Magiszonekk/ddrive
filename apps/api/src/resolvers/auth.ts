// ddrive v4 — Auth resolvers

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@ddv4/database";
import {
  signToken,
  invalidateSessionCache,
  invalidateApiKeyCache,
  hashApiKeyAuthPart,
} from "../middleware/auth.js";
import type { RegisterRequest, LoginResponse } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

// TODO(phase2): replace sha256 with argon2id for password hashing
function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function verifyPassword(password: string, hash: string): boolean {
  const presented = Buffer.from(hashPassword(password), "hex");
  const stored = Buffer.from(hash, "hex");
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
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

export async function register(input: RegisterRequest): Promise<LoginResponse> {
  const existingEmail = await db.user.findUnique({ where: { email: input.email } });
  if (existingEmail) throw new Error("Email already registered");

  const existingUsername = await db.user.findUnique({ where: { username: input.username } });
  if (existingUsername) throw new Error("Username already taken");

  const user = await db.user.create({
    data: {
      email: input.email,
      username: input.username,
      passwordHash: hashPassword(input.password),
    },
  });

  const token = signToken({ userId: user.id, email: user.email });
  await pluginRegistry.emitAsync("user:registered", { userId: user.id, email: user.email });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  };
}

export async function login(
  emailOrUsername: string,
  password: string,
  deviceName?: string | null,
): Promise<LoginResponse> {
  const user = await db.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
  });

  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error("Invalid credentials");
  }

  let token: string;
  let refreshToken: string | undefined;
  if (deviceName?.trim()) {
    ({ token, refreshToken } = await createDeviceSession(user.id, user.email, deviceName.trim()));
  } else {
    token = signToken({ userId: user.id, email: user.email });
  }

  return {
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

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    throw new Error("Current password is incorrect");
  }

  await db.user.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword) },
  });

  return true;
}
