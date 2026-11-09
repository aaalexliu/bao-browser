import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { assertChromeReadable, chromeDenied } from "../chrome-access";
import { closeRetainedChrome, launchOwnedChrome, launchOwnedChromeEndpoint, listedPids, pidsForDataDir, RESTORE_LAST_SESSION } from "../launch";

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
  catch (error) { throw chromeDenied(error, sourceRoot) ?? new Error("could not read Chrome profile metadata"); }
}

export async function listChromeProfiles(sourceRoot: string): Promise<ChromeProfileChoice[]> {
  assertChromeReadable(sourceRoot);
  const state = await readChromeState(sourceRoot);
  const cache = object(object(state.profile).info_cache);
  const folders = await readdir(sourceRoot, { withFileTypes: true });
  return folders.filter((folder) => folder.isDirectory() && /^(Default|Profile \d+)$/.test(folder.name)).map((folder) => {
    const directory = folder.name;
    const entry = object(cache[directory]);
    return { directory, name: typeof entry.name === "string" && entry.name ? entry.name : directory, email: typeof entry.user_name === "string" ? entry.user_name : "" };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const SKIPPED_ENTRIES = new Set([
  "Cache", "Code Cache", "GPUCache", "Media Cache", "CacheStorage", "ShaderCache", "GrShaderCache",
  "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "Crash Reports", "BrowserMetrics",
]);
const MAGIC = "bao-profile-copy-v1";
const SAVED_TABS = new Set(["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"]);

export interface CopiedProfile {
  userDataDir: string;
  profileDirectory: string;
  displayName: string;
  launchArgs: string[];
  bytes: number;
  copyMs: number;
  keepOpen(): Promise<void>;
  close(): Promise<void>;
}

function copyColor(source: unknown): number {
  const orange = 0xfff97316 | 0;
  const blue = 0xff2563eb | 0;
  if (typeof source !== "number" || !Number.isInteger(source) || source === 0) return orange;
  const distance = (color: number) => [0, 8, 16].reduce((sum, shift) => sum + (((source >> shift) & 255) - ((color >> shift) & 255)) ** 2, 0);
  return distance(orange) >= distance(blue) ? orange : blue;
}

/** Read only the selected source. Each run gets a fresh copy, never a persistent clone. */
export async function copyChromeProfile(options: {
  sourceRoot: string; directory: string; home: string; restoreTabs?: boolean;
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
    if (active && lease.retained !== true) throw new Error("a Chrome profile copy is still open; end that run before refreshing it");
    await closeRetainedChrome(dir);
    if (pidsForDataDir(dir).length) {
      if (lease.retained !== true) await writeFile(path.join(dir, "lease.json"), JSON.stringify({ ...lease, retained: true }), { mode: 0o600 });
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
  const userDataDir = path.join(root, `run-${randomUUID()}`);
  await mkdir(userDataDir, { mode: 0o700 });
  await writeFile(path.join(userDataDir, "lease.json"), JSON.stringify({ magic: MAGIC, namespace, pid: process.pid }), { mode: 0o600 });
  const started = Date.now();
  let bytes = 0;
  const keepOpen = () => writeFile(path.join(userDataDir, "lease.json"), JSON.stringify({ magic: MAGIC, namespace, pid: process.pid, retained: true }), { mode: 0o600 });
  const close = async () => {
    const deadline = Date.now() + 3000;
    // An unreadable process list counts as still open: the copy is kept for the next run to remove.
    const open = () => listedPids(userDataDir)?.length !== 0;
    while (open() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 80));
    if (open()) {
      await keepOpen();
      console.error(`bao profile copy browser still shutting down profile=${userDataDir}`);
      return;
    }
    await rm(userDataDir, { recursive: true, force: true });
  };
  try {
    await cp(source, path.join(userDataDir, choice.directory), {
      recursive: true, preserveTimestamps: true, force: false, errorOnExist: true,
      filter: async (file) => {
        const stat = await lstat(file);
        if (SKIPPED_ENTRIES.has(path.basename(file))) return false;
        if (options.restoreTabs === false && path.dirname(file) === source && SAVED_TABS.has(path.basename(file))) return false;
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("profile copy refused a link or special file");
        if (stat.isFile()) bytes += stat.size;
        if (Date.now() - started > 300_000 || bytes > 20 * 1024 ** 3) throw new Error("profile copy exceeded its five-minute or 20 GiB limit");
        return true;
      },
    });
    const extensionsDir = path.join(userDataDir, choice.directory, "Extensions");
    const copiedExtensions = await readdir(extensionsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const extension of copiedExtensions) {
      if (!extension.isDirectory()) continue;
      const extensionDir = path.join(extensionsDir, extension.name);
      for (const version of await readdir(extensionDir, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        let manifest: unknown;
        try {
          manifest = JSON.parse(await readFile(path.join(extensionDir, version.name, "manifest.json"), "utf8"));
        } catch { continue; }
        if (!object(manifest).theme) continue;
        await rm(extensionDir, { recursive: true });
        break;
      }
    }
    const localState = await readChromeState(options.sourceRoot);
    const profile = object(localState.profile);
    const entry = object(object(profile.info_cache)[choice.directory]);
    const displayName = `Bao copy of ${choice.name}`;
    const preferencesFile = path.join(userDataDir, choice.directory, "Preferences");
    let originalPreferences: string | undefined;
    let preferences: Record<string, unknown>;
    try {
      originalPreferences = await readFile(preferencesFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      const parsed: unknown = originalPreferences === undefined ? {} : JSON.parse(originalPreferences);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      preferences = object(parsed);
    } catch { throw new Error("could not read copied Chrome preferences"); }
    if (options.restoreTabs === false) preferences.session = { ...object(preferences.session), restore_on_startup: RESTORE_LAST_SESSION };
    const browser = object(preferences.browser);
    const theme = object(browser.theme);
    const color = copyColor(entry.profile_color_seed ?? theme.user_color2 ?? theme.user_color ?? object(object(preferences.autogenerated).theme).color ?? entry.profile_highlight_color);
    const profilePreferences = object(preferences.profile);
    // Prefer the origami fox; use the penguin if either source store names the fox.
    const avatarIndex = entry.avatar_icon === "chrome://theme/IDR_PROFILE_AVATAR_31" || profilePreferences.avatar_index === 31 ? 34 : 31;
    // Chrome can fall back to a GAIA photo for a default avatar even with GAIA use off.
    preferences.profile = { ...profilePreferences, exit_type: "Normal", name: displayName, using_default_name: false,
      avatar_index: avatarIndex, using_default_avatar: false, using_gaia_avatar: false };
    // Chrome's Customize Chrome user-color theme, not an extension. Set both generations
    // of the prefs so startup migration cannot restore the source's theme.
    preferences.browser = { ...browser, theme: { ...theme, user_color: color, user_color2: color,
      color_scheme: 1, color_scheme2: 1, color_variant: 3, color_variant2: 3,
      is_grayscale: false, is_grayscale2: false, follows_system_colors: false } };
    const extensions = object(preferences.extensions);
    preferences.extensions = { ...extensions, theme: { ...object(extensions.theme), id: "user_color_theme_id", pack: "" } };
    // A copied NTP background can extract its color again when the first tab opens.
    preferences.ntp = { ...object(preferences.ntp), custom_background_dict: {}, custom_background_dict2: {} };
    const encodedPreferences = JSON.stringify(preferences);
    bytes += Buffer.byteLength(encodedPreferences) - Buffer.byteLength(originalPreferences ?? "");
    await writeFile(preferencesFile, encodedPreferences, { mode: 0o600 });
    localState.profile = { ...profile, info_cache: { [choice.directory]: { ...entry, name: displayName,
      is_using_default_name: false, profile_color_seed: color, avatar_icon: `chrome://theme/IDR_PROFILE_AVATAR_${avatarIndex}`,
      is_using_default_avatar: false, use_gaia_picture: false } }, last_used: choice.directory, last_active_profiles: [choice.directory] };
    const encodedState = JSON.stringify(localState);
    bytes += Buffer.byteLength(encodedState);
    await writeFile(path.join(userDataDir, "Local State"), encodedState, { mode: 0o600 });
    return { userDataDir, profileDirectory: choice.directory, displayName,
      launchArgs: [`--profile-directory=${choice.directory}`, "--disable-sync", "--restore-last-session"],
      bytes, copyMs: Date.now() - started, close, keepOpen,
    };
  } catch (error) {
    await close();
    throw chromeDenied(error, options.sourceRoot) ?? error;
  }
}

/** Pass-through startup owns Chrome without attaching Playwright to restored tabs. */
export async function openCopiedChromeForProxy(options: {
  sourceRoot: string; directory: string; home: string; detached?: boolean; restoreTabs?: boolean;
}): Promise<{ target: { kind: "bao"; portFile: string }; close(): Promise<void>; keepOpen(): Promise<void>; isClosed(): boolean; closed: Promise<void>; bytes: number; copyMs: number }> {
  const copy = await copyChromeProfile(options);
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try { await chrome?.close(); } finally { await copy.close(); }
  })();
  try {
    chrome = await launchOwnedChromeEndpoint({
      userDataDir: copy.userDataDir, headless: false, childHome: userInfo().homedir,
      loadExtensions: false, preserveRestoredTabs: true, args: copy.launchArgs, detached: options.detached,
    });
    return {
      target: { kind: "bao", portFile: chrome.portFile }, closed: chrome.closed, close,
      isClosed: chrome.isClosed,
      async keepOpen() { await copy.keepOpen(); chrome!.keepOpen(); },
      bytes: copy.bytes, copyMs: copy.copyMs,
    };
  } catch (error) { await close(); throw error; }
}

/** The installed Chrome keeps its keychain identity; no helper, toggle, or native input is used. */
export async function openCopiedChrome(options: {
  sourceRoot: string; directory: string; home: string; loadExtensions?: boolean;
}): Promise<{ target: { kind: "bao"; portFile: string }; parkedTargetId: string; close(): Promise<void>; closed: Promise<void>; bytes: number; copyMs: number }> {
  const copy = await copyChromeProfile(options);
  let context: BrowserContext | undefined;
  const close = async (): Promise<void> => { try { await context?.close(); } finally { await copy.close(); } };
  try {
    context = await launchOwnedChrome({
      userDataDir: copy.userDataDir, headless: false, childHome: userInfo().homedir,
      loadExtensions: options.loadExtensions === true, preserveRestoredTabs: true,
      args: copy.launchArgs,
    });
    const closed = new Promise<void>((resolve) => context!.once("close", () => resolve()));
    const parkedPage = context.pages().find((page) => !page.isClosed())!;
    const session = await context.newCDPSession(parkedPage);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const watch = (page: Page): void => { page.once("close", () => {
      if (context?.pages().every((page) => page.isClosed())) void context.close().catch(() => undefined);
    }); };
    context.pages().filter((page) => !page.isClosed()).forEach(watch);
    context.on("page", watch);
    return {
      target: { kind: "bao", portFile: path.join(copy.userDataDir, "DevToolsActivePort") },
      parkedTargetId: targetInfo.targetId,
      bytes: copy.bytes, copyMs: copy.copyMs, closed, close,
    };
  } catch (error) { await close(); throw error; }
}
