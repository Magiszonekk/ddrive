import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const { login, register, refreshSession, listSessions, revokeSession } = await import("../../resolvers/auth.js");
const { verifySessionToken, verifyToken, invalidateSessionCache } = await import("../../middleware/auth.js");

const email = "device-sessions@example.com";
const username = "device_sessions_user";
const serverAuthProof = "device-session-proof-password";

async function resetFixtures() {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.deviceSession.deleteMany({ where: { userId: existing.id } });
    await db.user.delete({ where: { id: existing.id } });
  }

  await register({
    email,
    username,
    password: serverAuthProof,
  });
  // Mark the user as verified so login() doesn't reject the test fixture.
  // Email verification is exercised by the dedicated test in verify-email.test.ts.
  await db.user.update({ where: { email }, data: { emailVerified: true } });
}

describe("device sessions", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("login without deviceName issues a plain JWT and creates no session", async () => {
    const result = await login(email, serverAuthProof);
    expect(result.refreshToken).toBeUndefined();
    expect(result.token).toBeDefined();
    expect(result.user).toBeDefined();
    const payload = verifyToken(result.token!);
    expect(payload.sid).toBeUndefined();
    expect(await listSessions(result.user!.id)).toEqual([]);
  });

  it("login with deviceName creates a revocable session with refresh token", async () => {
    const result = await login(email, serverAuthProof, "Pixel 9");
    expect(result.refreshToken).toBeTruthy();
    expect(result.token).toBeDefined();

    const payload = verifyToken(result.token!);
    expect(payload.sid).toBeTruthy();

    const sessions = await listSessions(result.user!.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.deviceName).toBe("Pixel 9");
    expect(sessions[0]!.id).toBe(payload.sid);

    // Session-bound token passes validation while the session is active
    await expect(verifySessionToken(result.token!)).resolves.toMatchObject({ sid: payload.sid });
  });

  it("refreshSession issues a new session-bound access token", async () => {
    const { refreshToken, user } = await login(email, serverAuthProof, "Pixel 9");
    expect(refreshToken).toBeDefined();
    expect(user).toBeDefined();
    const refreshed = await refreshSession(refreshToken!);
    const payload = verifyToken(refreshed.token);
    expect(payload.userId).toBe(user!.id);
    expect(payload.sid).toBeTruthy();
  });

  it("refreshSession rejects unknown tokens", async () => {
    await expect(refreshSession("definitely-not-a-token")).rejects.toThrow("Invalid or expired session");
  });

  it("revokeSession kills both refresh and access tokens", async () => {
    const { token, refreshToken, user } = await login(email, serverAuthProof, "Pixel 9");
    expect(token).toBeDefined();
    expect(refreshToken).toBeDefined();
    expect(user).toBeDefined();
    const sid = verifyToken(token!).sid!;

    await expect(revokeSession(user!.id, sid)).resolves.toBe(true);

    await expect(refreshSession(refreshToken!)).rejects.toThrow("Invalid or expired session");
    invalidateSessionCache(sid);
    await expect(verifySessionToken(token!)).rejects.toThrow("Session revoked or expired");
    expect(await listSessions(user!.id)).toEqual([]);
  });

  it("revokeSession refuses sessions of other users", async () => {
    const { token } = await login(email, serverAuthProof, "Pixel 9");
    expect(token).toBeDefined();
    const sid = verifyToken(token!).sid!;
    await expect(revokeSession("someone-else", sid)).rejects.toThrow("Session not found");
  });
});
