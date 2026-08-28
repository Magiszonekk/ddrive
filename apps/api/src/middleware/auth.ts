// ddrive v4 — JWT authentication middleware

import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { serverConfig } from "@ddv4/config/server";

export interface AuthPayload {
  userId: string;
  email: string;
  sid?: string;
}

export type AuthVia = "jwt" | "apikey" | "system";

export interface ResolvedAuth extends AuthPayload {
  via: AuthVia;
  apiKeyAuthPart?: string;
}

export function signToken(payload: AuthPayload, expiresIn?: string): string {
  return jwt.sign(payload, serverConfig.jwtSecret, {
    expiresIn: expiresIn ?? serverConfig.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, serverConfig.jwtSecret) as AuthPayload;
}

const SESSION_CACHE_MS = 60_000;
const sessionCache = new Map<string, { validUntil: number; ok: boolean }>();

export function invalidateSessionCache(sid: string): void {
  sessionCache.delete(sid);
}

export async function isSessionActive(sid: string): Promise<boolean> {
  const now = Date.now();
  const cached = sessionCache.get(sid);
  if (cached && now < cached.validUntil) return cached.ok;

  const { db } = await import("@ddv4/database");
  const session = await db.deviceSession.findUnique({ where: { id: sid } });
  const ok = Boolean(session && !session.revokedAt && session.expiresAt > new Date());
  sessionCache.set(sid, { validUntil: now + SESSION_CACHE_MS, ok });
  return ok;
}

export async function verifySessionToken(token: string): Promise<AuthPayload> {
  const payload = verifyToken(token);
  if (payload.sid && !(await isSessionActive(payload.sid))) {
    throw new Error("Session revoked or expired");
  }
  return payload;
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export async function authenticateRequest(request: Request): Promise<AuthPayload> {
  const token = extractToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  return verifySessionToken(token);
}

const SYSTEM_USER_EMAIL = "system@ddv4.local";
let cachedSystemUserId: string | null = null;

export async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  const { db } = await import("@ddv4/database");
  // Upsert: concurrent first-time uploads can both miss the findUnique and
  // race on create (unique email violation). upsert handles that, and also
  // recovers if the cached id ever points at a deleted row.
  const user = await db.user.upsert({
    where: { email: SYSTEM_USER_EMAIL },
    create: { email: SYSTEM_USER_EMAIL, passwordHash: "" },
    update: {},
  });

  cachedSystemUserId = user.id;
  return cachedSystemUserId;
}

export function isBackendOnly(): boolean {
  return serverConfig.appMode === "backend-only";
}

export const API_KEY_PREFIX = "ddv4_";

export class LeakedApiKeyError extends Error {
  constructor() {
    super(
      "This looks like a full API key including its cryptoPart. Send only the ddv4_<authPart> half. " +
        "Treat the key as compromised and issue a new one.",
    );
    this.name = "LeakedApiKeyError";
  }
}

export function parseApiKeyHeader(raw: string): string | null {
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const body = raw.slice(API_KEY_PREFIX.length);
  if (!body) return null;
  if (body.includes(".")) throw new LeakedApiKeyError();
  return body;
}

export function hashApiKeyAuthPart(authPart: string): string {
  return createHash("sha256").update(authPart).digest("hex");
}

const API_KEY_CACHE_MS = 60_000;
const apiKeyCache = new Map<string, { validUntil: number; auth: AuthPayload | null }>();

export function invalidateApiKeyCache(keyHash?: string): void {
  if (keyHash) apiKeyCache.delete(keyHash);
  else apiKeyCache.clear();
}

async function authFromApiKey(rawHeader: string): Promise<AuthPayload | null> {
  const authPart = parseApiKeyHeader(rawHeader);
  if (!authPart) return null;

  const keyHash = hashApiKeyAuthPart(authPart);
  const now = Date.now();
  const cached = apiKeyCache.get(keyHash);
  if (cached && now < cached.validUntil) return cached.auth;

  const { db } = await import("@ddv4/database");
  const record = await db.apiKey.findUnique({
    where: { keyHash },
    include: { user: true },
  });

  const usable =
    record && !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date());
  const auth: AuthPayload | null = usable
    ? { userId: record.userId, email: record.user.email }
    : null;

  apiKeyCache.set(keyHash, { validUntil: now + API_KEY_CACHE_MS, auth });

  if (usable) {
    void db.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return auth;
}

export async function resolveRequestAuth(request: Request): Promise<ResolvedAuth | null> {
  const bearer = extractToken(request);
  if (bearer) {
    try {
      return { ...(await verifySessionToken(bearer)), via: "jwt" };
    } catch {
      return null;
    }
  }

  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) {
    if (apiKeyHeader.startsWith(API_KEY_PREFIX)) {
      const auth = await authFromApiKey(apiKeyHeader);
      if (!auth) return null;
      return { ...auth, via: "apikey", apiKeyAuthPart: parseApiKeyHeader(apiKeyHeader) ?? undefined };
    }

    if (isBackendOnly() && serverConfig.apiKey && apiKeyHeader === serverConfig.apiKey) {
      return { userId: await getSystemUserId(), email: SYSTEM_USER_EMAIL, via: "system" };
    }
  }

  return null;
}
