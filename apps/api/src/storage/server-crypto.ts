// ddrive — Server-side chunk encryption (Phase 1 of the non-E2EE fork)
//
// Chunks stay AES-256-GCM encrypted at rest on the storage provider (so a
// leaked webhook/bot token doesn't hand out raw files), but the DECRYPTION
// KEY LIVES HERE ON THE SERVER, not with any user. This is deliberately NOT
// end-to-end encryption — see docs/hermes/concept.md section 4.1. The server
// freely decrypts for thumbnails, streaming, search, and previews.
//
// Wire format: IV(12 bytes) || ciphertext || authTag(16 bytes)
// This mirrors the old client-side format (see git history of lib/crypto.ts)
// so existing chunk-size accounting (10 MiB - 28 bytes overhead) still holds.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { serverConfig } from "@ddv4/config/server";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = serverConfig.chunkEncryptionKey;
  if (!raw) {
    throw new Error(
      "CHUNK_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32) {
    throw new Error(
      `CHUNK_ENCRYPTION_KEY must decode to 32 bytes (AES-256), got ${key.byteLength}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  cachedKey = key;
  return cachedKey;
}

/** Encrypts plaintext bytes with the server key. Output includes IV + auth tag. */
export function encryptServerSide(plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

/** Decrypts bytes produced by encryptServerSide. Throws on tamper/corruption. */
export function decryptServerSide(wrapped: Uint8Array): Uint8Array {
  const buf = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped);
  if (buf.byteLength < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted blob is too short to contain IV + auth tag");
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.byteLength - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.byteLength - TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Plaintext size for a stored ciphertext of the given length (IV+tag overhead removed). */
export function plaintextSizeFor(ciphertextSizeBytes: number): number {
  return Math.max(0, ciphertextSizeBytes - IV_LENGTH - TAG_LENGTH);
}

export const CHUNK_CRYPTO_OVERHEAD_BYTES = IV_LENGTH + TAG_LENGTH;
