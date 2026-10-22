// Key sources for cookie decryption. The secret stays in memory for PBKDF2.
// Callers that talk to the UI use describeKeys() and keychainMessage(), which
// do not include the secret.

import { execFile } from "node:child_process";
import { deriveAesKey, LINUX_ITERATIONS, LINUX_PEANUTS, MAC_ITERATIONS, type KeyRing } from "./crypto";

export type SecretError = "prompt-missed" | "denied" | "not-found";

export interface KeySources {
  platform: "linux" | "darwin" | "win32";
  secret?: string;
  secretError?: SecretError;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type CommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

const MAC_ARGS = ["find-generic-password", "-s", "Chrome Safe Storage", "-a", "Chrome", "-w"];
const LINUX_LOOKUPS = [
  ["lookup", "application", "chrome", "xdg:schema", "chrome_libsecret_os_crypt_password_v2"],
  ["lookup", "application", "chrome", "xdg:schema", "chrome_libsecret_os_crypt_password"],
];
const KEYCHAIN_TIMEOUT_MS = 60_000;

export function keyRingFromSources(sources: KeySources): KeyRing {
  if (sources.platform === "darwin") {
    if (!sources.secret) return {};
    return { v10: deriveAesKey(sources.secret, MAC_ITERATIONS) };
  }
  if (sources.platform === "win32") return {};
  const ring: KeyRing = {
    v10: deriveAesKey(LINUX_PEANUTS, LINUX_ITERATIONS),
    empty: deriveAesKey("", LINUX_ITERATIONS),
  };
  if (sources.secret) ring.v11 = deriveAesKey(sources.secret, LINUX_ITERATIONS);
  return ring;
}

export function describeKeys(sources: KeySources): { platform: KeySources["platform"]; hasSecret: boolean; secretError?: SecretError } {
  return { platform: sources.platform, hasSecret: Boolean(sources.secret), secretError: sources.secretError };
}

export const KEYCHAIN_PREVIEW = {
  title: "macOS will ask for Chrome Safe Storage",
  body: "When you import, macOS asks whether bao may use the \"Chrome Safe Storage\" item in your keychain. Click Always Allow. If you do not see the prompt, look behind this window. Allow once makes the next import ask again.",
};

export function keychainMessage(error: SecretError): { title: string; body: string } {
  if (error === "not-found") {
    return {
      title: "Chrome Safe Storage is not in the keychain",
      body: "Bao looked for the keychain item \"Chrome Safe Storage\" (account Chrome) and did not find it. Chrome creates that item when it first stores a password. Bao did not decrypt any cookies.",
    };
  }
  const why = error === "denied"
    ? "The keychain prompt was dismissed."
    : "The keychain prompt was not answered. It may be behind this window.";
  return {
    title: "Allow the Chrome Safe Storage prompt",
    body: [
      why,
      "macOS asks whether bao may use the \"Chrome Safe Storage\" item in your keychain. That item is the key for this site's cookies.",
      "Click Always Allow.",
      "Allow once makes the next import ask again. A missed prompt does not mean the password was wrong.",
      "Bao reads cookies only for the site you clicked, and it does not show cookie values.",
    ].join(" "),
  };
}

export async function readPlatformKeys(opts?: { platform?: NodeJS.Platform; run?: CommandRunner }): Promise<KeySources> {
  const platform = opts?.platform ?? process.platform;
  const run = opts?.run ?? defaultRunner;
  if (platform === "darwin") return readMacKeychain(run);
  if (platform === "win32") return { platform: "win32" };
  return readLinuxSecret(run);
}

async function readMacKeychain(run: CommandRunner): Promise<KeySources> {
  const result = await run("security", MAC_ARGS, KEYCHAIN_TIMEOUT_MS);
  if (!result.timedOut && result.code === 0 && result.stdout.trim()) {
    return { platform: "darwin", secret: result.stdout.trim() };
  }
  return { platform: "darwin", secretError: classifyMacFailure(result) };
}

function classifyMacFailure(result: CommandResult): SecretError {
  const err = result.stderr.toLowerCase();
  if (err.includes("could not be found") || err.includes("item not found")) return "not-found";
  if (!result.timedOut && (err.includes("user canceled") || err.includes("user cancelled"))) return "denied";
  return "prompt-missed";
}

async function readLinuxSecret(run: CommandRunner): Promise<KeySources> {
  for (const args of LINUX_LOOKUPS) {
    const result = await run("secret-tool", args, 10_000);
    if (!result.timedOut && result.code === 0 && result.stdout.trim()) {
      return { platform: "linux", secret: result.stdout.trim() };
    }
  }
  return { platform: "linux", secretError: "not-found" };
}

export const macKeychainArgs = MAC_ARGS;
export const linuxSecretLookups = LINUX_LOOKUPS;

function defaultRunner(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
      const rawCode = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      const code = typeof rawCode === "number" ? rawCode : err ? 1 : 0;
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: stdout || "",
        stderr: stderr || "",
        timedOut,
      });
    });
  });
}
