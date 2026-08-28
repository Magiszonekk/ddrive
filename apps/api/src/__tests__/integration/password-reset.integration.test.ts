import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";
import {
  register,
  login,
  requestPasswordReset,
  resetPassword,
} from "../../resolvers/auth.js";

vi.mock("../../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

// Capture the reset link printed by the dev mailer fallback (no SMTP in CI).
function installResetLinkSpy(): { getToken: () => string; restore: () => void } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const getToken = () => {
    const line = spy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .find((l) => l.includes("/reset-password?token="));
    if (!line) throw new Error("reset link was not emitted by mailer");
    const m = line.match(/token=([^&\s]+)/);
    if (!m) throw new Error("token not found in reset link");
    return m[1];
  };
  return { getToken, restore: () => spy.mockRestore() };
}

const testEmail = `pwreset-${Date.now()}@example.com`;
const username = `pwreset_${Date.now()}`;
const oldPassword = "OldPass-2026!x";
const newPassword = "NewStr0ng-2026!y";

describe("password reset flow", () => {
  beforeEach(async () => {
    await db.user.deleteMany({ where: { email: testEmail } });
  });

  afterEach(async () => {
    await db.user.deleteMany({ where: { email: testEmail } });
  });

  it("request -> email sent -> reset -> login with new password, old rejected, token single-use", async () => {
    await register({ email: testEmail, username, password: oldPassword });

    const cap = installResetLinkSpy();
    const ok = await requestPasswordReset(testEmail, "127.0.0.1");
    expect(ok).toBe(true);
    const token = cap.getToken();
    cap.restore();

    // Stored value must be the hashed token (not raw), with a future expiry.
    const afterReq = await db.user.findUniqueOrThrow({ where: { email: testEmail } });
    expect(afterReq.passwordResetToken).not.toBe(token);
    expect(afterReq.passwordResetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(afterReq.passwordResetExpires?.getTime()).toBeGreaterThan(Date.now());

    // Reset with the token.
    expect(await resetPassword(token, newPassword)).toBe(true);

    // New password works; old is rejected.
    expect((await login(testEmail, newPassword)).token).toBeTruthy();
    await expect(login(testEmail, oldPassword)).rejects.toThrow();

    // Token is single-use.
    await expect(resetPassword(token, "Another-2026!z")).rejects.toThrow();

    // Reset fields cleared.
    const cleared = await db.user.findUniqueOrThrow({ where: { email: testEmail } });
    expect(cleared.passwordResetToken).toBeNull();
    expect(cleared.passwordResetExpires).toBeNull();
  });

  it("requestPasswordReset returns true even for unknown email (no enumeration)", async () => {
    expect(await requestPasswordReset("does-not-exist@example.com", "127.0.0.2")).toBe(true);
  });

  it("resetPassword rejects an expired token", async () => {
    await register({ email: testEmail, username, password: oldPassword });
    await db.user.update({
      where: { email: testEmail },
      data: {
        passwordResetToken: "a".repeat(64),
        passwordResetExpires: new Date(Date.now() - 1000),
      },
    });
    await expect(resetPassword("a".repeat(32), newPassword)).rejects.toThrow();
  });
});
