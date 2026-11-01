import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { launchOwnedChrome, pidsForDataDir } from "../launch";
import type { LiveTarget } from "../cdp-live/live-target";

export interface ChromeProfileChoice {
  directory: string;
  name: string;
  email: string;
}

export function chromeProfilesRoot(): string {
  if (process.platform !== "darwin") throw new Error("Chrome profile copies are a Mac-only trial");
  return path.join(userInfo().homedir, "Library", "Application Support", "Google", "Chrome");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readChromeState(sourceRoot: string): Promise<Record<string, unknown>> {
  try { return object(JSON.parse(await readFile(path.join(sourceRoot, "Local State"), "utf8"))); }
  catch { throw new Error("could not read Chrome profile metadata"); }
}

export async function listChromeProfiles(sourceRoot: string): Promise<ChromeProfileChoice[]> {
  const state = await readChromeState(sourceRoot);
  const cache = object(object(state.profile).info_cache);
  return Object.entries(cache).flatMap(([directory, value]) => {
    if (!/^(Default|Profile \d+)$/.test(directory)) return [];
    const entry = object(value);
    if (typeof entry.name !== "string") return [];
    return [{ directory, name: entry.name, email: typeof entry.user_name === "string" ? entry.user_name : "" }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const SKIPPED_ENTRIES = new Set([
  "Cache", "Code Cache", "GPUCache", "Media Cache", "CacheStorage", "ShaderCache", "GrShaderCache",
  "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "Crash Reports", "BrowserMetrics",
  "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs",
]);
const MAGIC = "bao-profile-copy-v1";

export interface CopiedProfile {
  userDataDir: string;
  profileDirectory: string;
  bytes: number;
  copyMs: number;
  close(): Promise<void>;
}

/** Read only the selected source. Each run gets a fresh copy, never a persistent clone. */
export async function copyChromeProfile(options: {
  sourceRoot: string; directory: string; home: string;
}): Promise<CopiedProfile> {
  const choices = await listChromeProfiles(options.sourceRoot);
  const choice = choices.find((entry) => entry.directory === options.directory);
  if (!choice) throw new Error("choose an existing Chrome profile before starting agent-browser");
  const source = path.join(options.sourceRoot, choice.directory);
  if (!(await lstat(source)).isDirectory()) throw new Error("the selected Chrome profile is not a plain directory");
  const namespace = createHash("sha256").update(path.resolve(options.home)).digest("hex").slice(0, 20);
  const root = path.join(tmpdir(), `bao-profile-copies-${namespace}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owner = await lstat(root);
  if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid())) throw new Error("profile copy root is not a private Bao directory");
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[a-f0-9-]+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const lease = object(await readFile(path.join(dir, "lease.json"), "utf8").then(JSON.parse).catch(() => null));
    if (lease.magic !== MAGIC || lease.namespace !== namespace || typeof lease.pid !== "number") continue;
    let active = false;
    try { process.kill(lease.pid, 0); active = true; } catch (error) { active = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (active || pidsForDataDir(dir).length) throw new Error("a Chrome profile copy is still open; end that run before refreshing it");
    await rm(dir, { recursive: true, force: true });
  }
  const userDataDir = path.join(root, `run-${randomUUID()}`);
  await mkdir(userDataDir, { mode: 0o700 });
  await writeFile(path.join(userDataDir, "lease.json"), JSON.stringify({ magic: MAGIC, namespace, pid: process.pid }), { mode: 0o600 });
  const started = Date.now();
  let bytes = 0;
  const close = async () => {
    const deadline = Date.now() + 3000;
    while (pidsForDataDir(userDataDir).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 80));
    if (pidsForDataDir(userDataDir).length) throw new Error("Chrome still uses the private copy; Bao refused to delete an open profile");
    await rm(userDataDir, { recursive: true, force: true });
  };
  try {
    await cp(source, path.join(userDataDir, choice.directory), {
      recursive: true, preserveTimestamps: true, force: false, errorOnExist: true,
      filter: async (file) => {
        const stat = await lstat(file);
        if (SKIPPED_ENTRIES.has(path.basename(file))) return false;
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("profile copy refused a link or special file");
        if (stat.isFile()) bytes += stat.size;
        if (Date.now() - started > 300_000 || bytes > 20 * 1024 ** 3) throw new Error("profile copy exceeded its five-minute or 20 GiB limit");
        return true;
      },
    });
    const localState = await readChromeState(options.sourceRoot);
    const profile = object(localState.profile);
    localState.profile = { ...profile, info_cache: { [choice.directory]: object(profile.info_cache)[choice.directory] }, last_used: choice.directory, last_active_profiles: [choice.directory] };
    const encodedState = JSON.stringify(localState);
    bytes += Buffer.byteLength(encodedState);
    await writeFile(path.join(userDataDir, "Local State"), encodedState, { mode: 0o600 });
    return { userDataDir, profileDirectory: choice.directory, bytes, copyMs: Date.now() - started, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The installed Chrome keeps its keychain identity; no helper, toggle, or native input is used. */
export async function openCopiedChrome(options: {
  sourceRoot: string; directory: string; home: string; loadExtensions?: boolean;
}): Promise<{ target: LiveTarget; close(): Promise<void>; bytes: number; copyMs: number }> {
  const copy = await copyChromeProfile(options);
  try {
    const context = await launchOwnedChrome({
      userDataDir: copy.userDataDir, headless: false, childHome: userInfo().homedir,
      loadExtensions: options.loadExtensions === true,
      args: [`--profile-directory=${copy.profileDirectory}`, "--disable-sync"],
    });
    return {
      target: { kind: "bao", portFile: path.join(copy.userDataDir, "DevToolsActivePort") },
      bytes: copy.bytes, copyMs: copy.copyMs,
      async close() { try { await context.close(); } finally { await copy.close(); } },
    };
  } catch (error) { await copy.close(); throw error; }
}
