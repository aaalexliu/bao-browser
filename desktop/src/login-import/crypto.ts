// Chrome cookie values on macOS and Linux.
//
// Ciphertext is "v10" or "v11" plus AES-128-CBC. The key is PBKDF2-HMAC-SHA1
// over the password, salt "saltysalt", 16-byte output. The IV is 16 spaces.
// macOS uses the "Chrome Safe Storage" keychain password and 1003 iterations.
// Linux v10 uses the password "peanuts" and 1 iteration. Linux v11 uses the
// same KDF with the libsecret password. Cookie DB meta version 24 and later
// prepends raw SHA-256(host_key) to the plaintext before encryption.

import crypto from "node:crypto";

export const SALT = "saltysalt";
export const LINUX_PEANUTS = "peanuts";
export const LINUX_ITERATIONS = 1;
export const MAC_ITERATIONS = 1003;
export const IV = Buffer.alloc(16, 0x20);
const HOST_PREFIX_BYTES = 32;

export interface KeyRing {
  v10?: Buffer;
  v11?: Buffer;
  /** Linux retry for the empty-password key Chrome still accepts on decrypt. */
  empty?: Buffer;
}

export type DecryptResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function deriveAesKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, SALT, iterations, 16, "sha1");
}

export function encryptCookieValue(plaintext: Buffer, password: string, iterations: number, prefix: "v10" | "v11"): Buffer {
  const key = deriveAesKey(password, iterations);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, IV);
  return Buffer.concat([Buffer.from(prefix, "utf8"), cipher.update(plaintext), cipher.final()]);
}

export function plaintextForCookie(hostKey: string, value: string, hostPrefix: boolean): Buffer {
  const raw = Buffer.from(value, "utf8");
  if (!hostPrefix) return raw;
  return Buffer.concat([crypto.createHash("sha256").update(hostKey, "utf8").digest(), raw]);
}

export function decryptCookieValue(blob: Buffer, hostKey: string, metaVersion: number, ring: KeyRing): DecryptResult {
  if (blob.length < 4) return { ok: false, reason: "could not decrypt" };
  const prefix = blob.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") return { ok: false, reason: "unsupported cipher" };
  const key = prefix === "v11" ? ring.v11 : ring.v10;
  if (!key) {
    return { ok: false, reason: prefix === "v11" ? "libsecret key is missing" : "Chrome Safe Storage key is missing" };
  }
  const decrypted = decryptAes(blob.subarray(3), key) ?? (ring.empty ? decryptAes(blob.subarray(3), ring.empty) : null);
  if (!decrypted) return { ok: false, reason: "could not decrypt" };
  return stripHostPrefix(decrypted, hostKey, metaVersion);
}

function decryptAes(ciphertext: Buffer, key: Buffer): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, IV);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function stripHostPrefix(plain: Buffer, hostKey: string, metaVersion: number): DecryptResult {
  if (metaVersion < 24) return { ok: true, value: plain.toString("utf8") };
  const expected = crypto.createHash("sha256").update(hostKey, "utf8").digest();
  if (plain.length < HOST_PREFIX_BYTES || !plain.subarray(0, HOST_PREFIX_BYTES).equals(expected)) {
    return { ok: false, reason: "host prefix does not match" };
  }
  return { ok: true, value: plain.subarray(HOST_PREFIX_BYTES).toString("utf8") };
}
