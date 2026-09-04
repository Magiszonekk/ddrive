import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

vi.mock("../../lib/mailer.js", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

const { register, verifyEmail, resendVerification, login } = await import("../../resolvers/auth.js");

const email = "verify-test@example.com";
const username = "verify_user";
const password = "verify-test-password";

async function resetFixtures() {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.emailVerification.deleteMany({ where: { userId: existing.id } });
    await db.user.delete({ where: { id: existing.id } });
  }
}

describe("email verification", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("register returns requiresEmailVerification and the user cannot log in", async () => {
    const res = await register({ email, username, password });
    expect(res.requiresEmailVerification).toBe(true);
    expect(res.email).toBe(email);

    await expect(login(email, password)).rejects.toThrow("Email not verified");
  });

  it("verifyEmail flips the flag and returns a session", async () => {
    await register({ email, username, password });
    const row = await db.emailVerification.findFirst({
      where: { user: { email } },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    expect(row!.usedAt).toBeNull();

    // We have the hashed token; we need the raw one to call verifyEmail.
    // Easiest way: insert a fresh token we know, then verify it.
    const { randomBytes, createHash } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await db.emailVerification.create({
      data: {
        userId: row!.userId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await verifyEmail(raw);
    expect(res.token).toBeDefined();
    expect(res.user?.email).toBe(email);
    expect(res.requiresEmailVerification).toBe(false);

    // The original row is still unused (we verified a different one);
    // the new one should be marked used.
    const used = await db.emailVerification.findFirst({
      where: { tokenHash: createHash("sha256").update(raw).digest("hex") },
    });
    expect(used?.usedAt).toBeTruthy();

    // Now login works.
    const after = await login(email, password);
    expect(after.token).toBeDefined();
  });

  it("verifyEmail rejects unknown tokens", async () => {
    await expect(verifyEmail("not-a-real-token")).rejects.toThrow("Invalid verification token");
  });

  it("verifyEmail rejects expired tokens", async () => {
    await register({ email, username, password });
    const { randomBytes, createHash } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await db.emailVerification.create({
      data: {
        userId: (await db.user.findUnique({ where: { email } }))!.id,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(verifyEmail(raw)).rejects.toThrow("Verification link expired");
  });

  it("resendVerification generates a new token for unverified users", async () => {
    await register({ email, username, password });
    const before = await db.emailVerification.count({ where: { user: { email } } });
    await expect(resendVerification(email)).resolves.toBe(true);
    const after = await db.emailVerification.count({ where: { user: { email } } });
    expect(after).toBe(before + 1);
  });

  it("resendVerification is a no-op for already-verified users", async () => {
    await register({ email, username, password });
    const user = (await db.user.findUnique({ where: { email } }))!;
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    const before = await db.emailVerification.count({ where: { user: { email } } });
    await expect(resendVerification(email)).resolves.toBe(true);
    const after = await db.emailVerification.count({ where: { user: { email } } });
    expect(after).toBe(before);
  });

  it("resendVerification is a no-op for unknown emails (no enumeration)", async () => {
    await expect(resendVerification("nobody@nowhere.example")).resolves.toBe(true);
  });
});
