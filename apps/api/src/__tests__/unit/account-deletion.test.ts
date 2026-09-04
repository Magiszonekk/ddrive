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
  sendAccountDeletionEmail: vi.fn().mockResolvedValue(undefined),
}));

const { register, requestAccountDeletion, confirmAccountDeletion } = await import("../../resolvers/auth.js");

const email = "delete-test@example.com";
const username = "delete_test_user";
const password = "delete-test-password";

async function makeVerifiedUser() {
  await register({ email, username, password });
  const user = (await db.user.findUnique({ where: { email } }))!;
  await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  return user;
}

async function resetFixtures() {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.accountDeletion.deleteMany({ where: { userId: existing.id } });
    await db.emailVerification.deleteMany({ where: { userId: existing.id } });
    await db.user.delete({ where: { id: existing.id } }).catch(() => undefined);
  }
}

describe("account deletion", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("requestAccountDeletion rejects a wrong password", async () => {
    const user = await makeVerifiedUser();
    await expect(requestAccountDeletion(user.id, "totally-wrong")).rejects.toThrow("Current password is incorrect");
  });

  it("requestAccountDeletion issues a deletion token without deleting anything yet", async () => {
    const user = await makeVerifiedUser();
    await expect(requestAccountDeletion(user.id, password)).resolves.toBe(true);

    const stillThere = await db.user.findUnique({ where: { id: user.id } });
    expect(stillThere).not.toBeNull();

    const row = await db.accountDeletion.findFirst({ where: { userId: user.id } });
    expect(row).toBeTruthy();
    expect(row!.usedAt).toBeNull();
  });

  it("confirmAccountDeletion actually deletes the user and cascades", async () => {
    const user = await makeVerifiedUser();
    await requestAccountDeletion(user.id, password);

    const { randomBytes, createHash } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await db.accountDeletion.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(confirmAccountDeletion(raw)).resolves.toBe(true);

    const gone = await db.user.findUnique({ where: { id: user.id } });
    expect(gone).toBeNull();
  });

  it("confirmAccountDeletion rejects unknown tokens", async () => {
    await expect(confirmAccountDeletion("not-a-real-token")).rejects.toThrow("Invalid deletion token");
  });

  it("confirmAccountDeletion rejects an already-used token", async () => {
    const user = await makeVerifiedUser();
    const { randomBytes, createHash } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await db.accountDeletion.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await confirmAccountDeletion(raw);
    await expect(confirmAccountDeletion(raw)).rejects.toThrow(/already used|Invalid deletion token/);
  });

  it("confirmAccountDeletion rejects an expired token", async () => {
    const user = await makeVerifiedUser();
    const { randomBytes, createHash } = await import("node:crypto");
    const raw = randomBytes(32).toString("base64url");
    await db.accountDeletion.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(confirmAccountDeletion(raw)).rejects.toThrow("Deletion link expired");
  });
});
