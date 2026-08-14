// ddrive v4 — Seed script to create default user "Magiszonek" after reset

import { db } from "@ddv4/database";
import { createHash } from "node:crypto";

export async function createMagiszonekIfNeeded(): Promise<void> {
  const existingUser = await db.user.findUnique({
    where: { username: "Magiszonek" },
  });

  if (existingUser) {
    console.log("User Magiszonek already exists, skipping creation.");
    return;
  }

  console.log("Creating user Magiszonek...");

  // TODO: use argon2id once the argon2 dependency is wired in (Phase 2)
  const password = "Magiszonek_dev_2025!";
  const passwordHash = createHash("sha256").update(password).digest("hex");

  const randomPart = Math.random().toString(36).substring(2, 15);
  const email = `magiszonek-${randomPart}@example.com`;

  await db.user.create({
    data: {
      email,
      username: "Magiszonek",
      passwordHash,
    },
  });

  console.log(`Created user Magiszonek with email: ${email}, password: ${password}`);
}
