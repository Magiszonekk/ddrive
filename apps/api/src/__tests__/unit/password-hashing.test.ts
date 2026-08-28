import { describe, expect, it } from "vitest";
import { verifyPassword, hashPassword } from "../../resolvers/auth.js";
import { createHash } from "node:crypto";

// Legacy format: unsalted sha256 hex digest (what prod users currently have).
function legacySha256(pw: string): string {
  return createHash("sha256").update(pw).digest("hex");
}

describe("password hashing (argon2id + legacy sha256 compat)", () => {
  it("produces an argon2id hash that verifies and is not equal to the raw password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("uses a per-password salt (two hashes of the same password differ)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("still verifies legacy unsalted sha256 hashes", async () => {
    const legacy = legacySha256("old-insecure-password");
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPassword("old-insecure-password", legacy)).toBe(true);
    expect(await verifyPassword("not-the-password", legacy)).toBe(false);
  });

  it("rejects malformed hashes without throwing", async () => {
    expect(await verifyPassword("whatever", "not-a-valid-hash")).toBe(false);
    expect(await verifyPassword("whatever", "")).toBe(false);
  });
});
