import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";
import { launchOwnedChrome } from "../../src/launch";
import { copyChromeProfile, listChromeProfiles, openCopiedChrome, openCopiedChromeForProxy } from "../../src/engines/chrome-profile-copy";
import { startApp } from "../../src/app/server";

interface TestPreferences {
  profile: { exit_type: string; name: string; using_default_name: boolean; avatar_index: number; using_default_avatar: boolean; using_gaia_avatar: boolean };
  session: { restore_on_startup: number; startup_urls?: string[] };
  signin: { allowed: boolean };
  account_info: { email: string; gaia: string }[];
  browser: { theme: Record<string, number | boolean> };
  extensions: { theme: { id: string; pack: string }; settings: { addon: { state: number } } };
  ntp: { custom_background_dict2: Record<string, unknown>; num_personal_suggestions: number };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bao-copy-test-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default", "Cache"), { recursive: true });
  await mkdir(path.join(sourceRoot, "Default", "Sessions"), { recursive: true });
  await mkdir(path.join(sourceRoot, "Default", "Session Storage"), { recursive: true });
  await mkdir(path.join(sourceRoot, "Profile 1"), { recursive: true });
  const local = { os_crypt: { encrypted_key: "synthetic-not-a-real-key" }, profile: { last_used: "Profile 1", info_cache: {
    Default: { name: "Profile A", user_name: "a@example.test", is_using_default_name: true, profile_color_seed: 0xff1565c0 | 0,
      avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_33", is_using_default_avatar: true, use_gaia_picture: true },
    "Profile 1": { name: "Profile B", user_name: "b@example.test" }, "../outside": { name: "bad" },
  } } };
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify(local));
  await writeFile(path.join(sourceRoot, "Default", "Cookies"), "synthetic-cookie-file");
  const preferences: TestPreferences = {
    profile: { exit_type: "Crashed", name: "Profile A", using_default_name: true, avatar_index: 33, using_default_avatar: true, using_gaia_avatar: true },
    session: { restore_on_startup: 4, startup_urls: ["https://example.test/start"] }, signin: { allowed: true },
    account_info: [{ email: "a@example.test", gaia: "synthetic-account-id" }],
    browser: { theme: { user_color2: 0xff1565c0 | 0, color_scheme2: 2, is_grayscale2: true } },
    extensions: { theme: { id: "synthetic-theme-extension", pack: "old/theme.pack" }, settings: { addon: { state: 1 } } },
    ntp: { custom_background_dict2: { background_url: "https://example.test/background", main_color: 123 }, num_personal_suggestions: 3 },
  };
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), JSON.stringify(preferences));
  await writeFile(path.join(sourceRoot, "Default", "Secure Preferences"), "synthetic-secure-preferences");
  await writeFile(path.join(sourceRoot, "Default", "Cache", "entry"), "disposable");
  await writeFile(path.join(sourceRoot, "Default", "Sessions", "tab"), "synthetic-saved-tabs");
  await writeFile(path.join(sourceRoot, "Default", "Session Storage", "entry"), "synthetic-per-tab-token");
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    await writeFile(path.join(sourceRoot, "Default", name), "synthetic-legacy-session");
  }
  return { root, sourceRoot, local, preferences, home: path.join(root, "home"), close: () => rm(root, { recursive: true, force: true }) };
}

async function sourceBytes(root: string): Promise<Record<string, Buffer>> {
  const files: Record<string, Buffer> = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = await readFile(file);
    }
  }
  await visit(root);
  return files;
}

test("chooser lists display names, account emails and exact directories from Local State", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await listChromeProfiles(f.sourceRoot), [
      { directory: "Default", name: "Profile A", email: "a@example.test" },
      { directory: "Profile 1", name: "Profile B", email: "b@example.test" },
    ]);
    await assert.rejects(copyChromeProfile({ ...f, directory: "../outside" }), /choose an existing/);
  } finally { await f.close(); }
});

test("malformed profile metadata never echoes file contents in an error", async () => {
  const f = await fixture();
  try {
    const marker = "sensitive-synthetic-metadata";
    await writeFile(path.join(f.sourceRoot, "Local State"), `{broken:${marker}`);
    await assert.rejects(listChromeProfiles(f.sourceRoot), (error: Error) => {
      assert.equal(error.message.includes(marker), false);
      return /could not read Chrome profile metadata/.test(error.message);
    });
  } finally { await f.close(); }
});

test("copy is private, fresh, selected-profile-only, and leaves source bytes unchanged", async () => {
  const f = await fixture();
  let privateRoot = "";
  try {
    const before = await sourceBytes(f.sourceRoot);
    const first = await copyChromeProfile({ ...f, directory: "Default" });
    privateRoot = path.dirname(first.userDataDir);
    assert.equal((await stat(first.userDataDir)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(first.userDataDir, "Default", "Cookies"), "utf8"), "synthetic-cookie-file");
    assert.deepEqual((await readdir(path.join(first.userDataDir, "Default"))).sort(),
      ["Cookies", "Current Session", "Current Tabs", "Last Session", "Last Tabs", "Preferences", "Secure Preferences", "Session Storage", "Sessions"]);
    const savedFiles = ["Sessions/tab", "Session Storage/entry", "Current Session", "Current Tabs", "Last Session", "Last Tabs"];
    for (const file of savedFiles) {
      assert.deepEqual(await readFile(path.join(first.userDataDir, "Default", file)), before[`Default/${file}`]);
    }
    await assert.rejects(stat(path.join(first.userDataDir, "Profile 1")), /ENOENT/);
    const state = JSON.parse(await readFile(path.join(first.userDataDir, "Local State"), "utf8")) as typeof f.local;
    assert.equal(state.profile.last_used, "Default");
    assert.deepEqual(Object.keys(state.profile.info_cache), ["Default"]);
    assert.equal(state.os_crypt.encrypted_key, "synthetic-not-a-real-key");
    assert.equal(first.displayName, "Bao copy of Profile A");
    assert.deepEqual(first.launchArgs, ["--profile-directory=Default", "--disable-sync", "--restore-last-session"]);
    assert.equal(state.profile.info_cache.Default.name, first.displayName);
    assert.equal(state.profile.info_cache.Default.is_using_default_name, false);
    assert.equal(state.profile.info_cache.Default.user_name, "a@example.test");
    const prefs = JSON.parse(await readFile(path.join(first.userDataDir, "Default", "Preferences"), "utf8")) as TestPreferences;
    assert.deepEqual(prefs.profile, { exit_type: "Normal", name: first.displayName, using_default_name: false,
      avatar_index: 31, using_default_avatar: false, using_gaia_avatar: false });
    assert.equal(state.profile.info_cache.Default.avatar_icon, "chrome://theme/IDR_PROFILE_AVATAR_31");
    assert.equal(state.profile.info_cache.Default.is_using_default_avatar, false);
    assert.equal(state.profile.info_cache.Default.use_gaia_picture, false);
    assert.equal(prefs.browser.theme.user_color2, 0xfff97316 | 0);
    assert.equal(prefs.browser.theme.user_color, prefs.browser.theme.user_color2);
    assert.equal(state.profile.info_cache.Default.profile_color_seed, prefs.browser.theme.user_color2);
    assert.equal(prefs.browser.theme.color_scheme2, 1);
    assert.equal(prefs.browser.theme.color_variant2, 3);
    assert.equal(prefs.browser.theme.is_grayscale2, false);
    assert.equal(prefs.extensions.theme.id, "user_color_theme_id");
    assert.equal(prefs.extensions.theme.pack, "");
    assert.deepEqual(prefs.ntp.custom_background_dict2, {});
    assert.equal(prefs.ntp.num_personal_suggestions, 3);
    const originalPrefs = JSON.parse(before["Default/Preferences"].toString()) as TestPreferences;
    for (const key of ["session", "signin"] as const) assert.deepEqual(prefs[key], originalPrefs[key]);
    assert.equal((prefs as Partial<TestPreferences>).account_info, undefined, "the copy is not signed in to Chrome");
    assert.deepEqual(prefs.extensions.settings, originalPrefs.extensions.settings);
    assert.deepEqual(await readFile(path.join(first.userDataDir, "Default", "Secure Preferences")), before["Default/Secure Preferences"]);
    assert.deepEqual(await sourceBytes(f.sourceRoot), before);
    assert.equal(first.bytes, Buffer.byteLength("synthetic-cookie-file") + Buffer.byteLength("synthetic-secure-preferences")
      + savedFiles.reduce((sum, file) => sum + before[`Default/${file}`].length, 0)
      + Buffer.byteLength(JSON.stringify(prefs))
      + Buffer.byteLength(JSON.stringify(state)));
    assert.ok(first.copyMs >= 0);
    await assert.rejects(copyChromeProfile({ ...f, directory: "Default" }), /still open/);
    await first.close();
    await assert.rejects(stat(first.userDataDir), /ENOENT/);
    await writeFile(path.join(f.sourceRoot, "Default", "Cookies"), "refreshed-synthetic-cookie-file");
    const second = await copyChromeProfile({ ...f, directory: "Default" });
    assert.notEqual(first.userDataDir, second.userDataDir);
    assert.equal(await readFile(path.join(second.userDataDir, "Default", "Cookies"), "utf8"), "refreshed-synthetic-cookie-file");
    await second.close();
    assert.deepEqual(await sourceBytes(f.sourceRoot), { ...before, "Default/Cookies": Buffer.from("refreshed-synthetic-cookie-file") });
    assert.equal(await readFile(path.join(f.sourceRoot, "Default", "Cache", "entry"), "utf8"), "disposable");
    assert.equal(await readFile(path.join(f.sourceRoot, "Default", "Sessions", "tab"), "utf8"), "synthetic-saved-tabs");
    for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
      assert.equal(await readFile(path.join(f.sourceRoot, "Default", name), "utf8"), "synthetic-legacy-session");
    }
  } finally { if (privateRoot) await rm(privateRoot, { recursive: true, force: true }); await f.close(); }
});

test("copy uses the penguin when either source avatar store names the fox", async () => {
  const f = await fixture();
  try {
    for (const [stateIndex, preferenceIndex] of [[31, 31], [31, 33], [33, 31], [34, 34]]) {
      f.local.profile.info_cache.Default.avatar_icon = `chrome://theme/IDR_PROFILE_AVATAR_${stateIndex}`;
      f.preferences.profile.avatar_index = preferenceIndex;
      await writeFile(path.join(f.sourceRoot, "Local State"), JSON.stringify(f.local));
      await writeFile(path.join(f.sourceRoot, "Default", "Preferences"), JSON.stringify(f.preferences));
      const before = await sourceBytes(f.sourceRoot);
      const copy = await copyChromeProfile({ ...f, directory: "Default" });
      try {
        const state = JSON.parse(await readFile(path.join(copy.userDataDir, "Local State"), "utf8")) as typeof f.local;
        const prefs = JSON.parse(await readFile(path.join(copy.userDataDir, "Default", "Preferences"), "utf8")) as TestPreferences;
        const expected = stateIndex === 31 || preferenceIndex === 31 ? 34 : 31;
        assert.equal(prefs.profile.avatar_index, expected);
        assert.equal(prefs.profile.using_default_avatar, false);
        assert.equal(prefs.profile.using_gaia_avatar, false);
        assert.equal(state.profile.info_cache.Default.avatar_icon, `chrome://theme/IDR_PROFILE_AVATAR_${expected}`);
        assert.equal(state.profile.info_cache.Default.is_using_default_avatar, false);
        assert.equal(state.profile.info_cache.Default.use_gaia_picture, false);
        assert.deepEqual(await sourceBytes(f.sourceRoot), before);
      } finally { await copy.close(); }
    }
  } finally { await f.close(); }
});

test("copy picks a contrasting color for an already orange profile", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.sourceRoot, "Local State");
    const state = JSON.parse(await readFile(file, "utf8")) as typeof f.local;
    state.profile.info_cache.Default.profile_color_seed = 0xfff97316 | 0;
    await writeFile(file, JSON.stringify(state));
    const before = await sourceBytes(f.sourceRoot);
    const copy = await copyChromeProfile({ ...f, directory: "Default" });
    try {
      const prefs = JSON.parse(await readFile(path.join(copy.userDataDir, "Default", "Preferences"), "utf8")) as TestPreferences;
      assert.equal(prefs.browser.theme.user_color2, 0xff2563eb | 0);
      assert.deepEqual(await sourceBytes(f.sourceRoot), before);
    } finally { await copy.close(); }
  } finally { await f.close(); }
});

test("copy marks an uninitialized non-default profile without creating source preferences", async () => {
  const f = await fixture();
  try {
    const before = await sourceBytes(f.sourceRoot);
    const copy = await copyChromeProfile({ ...f, directory: "Profile 1" });
    try {
      const prefs = JSON.parse(await readFile(path.join(copy.userDataDir, "Profile 1", "Preferences"), "utf8")) as TestPreferences;
      assert.deepEqual(copy.launchArgs, ["--profile-directory=Profile 1", "--disable-sync", "--restore-last-session"]);
      assert.equal(prefs.session, undefined);
      assert.equal(prefs.profile.exit_type, "Normal");
      assert.equal(prefs.profile.name, "Bao copy of Profile B");
      assert.equal(prefs.profile.using_default_name, false);
      assert.equal(prefs.profile.avatar_index, 31);
      assert.equal(prefs.profile.using_default_avatar, false);
      assert.equal(prefs.profile.using_gaia_avatar, false);
      const state = JSON.parse(await readFile(path.join(copy.userDataDir, "Local State"), "utf8")) as {
        profile: { info_cache: Record<string, { avatar_icon: string; is_using_default_avatar: boolean; use_gaia_picture: boolean }> };
      };
      assert.equal(state.profile.info_cache["Profile 1"].avatar_icon, "chrome://theme/IDR_PROFILE_AVATAR_31");
      assert.equal(state.profile.info_cache["Profile 1"].is_using_default_avatar, false);
      assert.equal(state.profile.info_cache["Profile 1"].use_gaia_picture, false);
      assert.equal(prefs.browser.theme.user_color2, 0xfff97316 | 0);
      assert.deepEqual(await sourceBytes(f.sourceRoot), before);
      await assert.rejects(stat(path.join(copy.userDataDir, "Default")), /ENOENT/);
    } finally { await copy.close(); }
  } finally { await f.close(); }
});

test("malformed copied preferences stop before Chrome starts without exposing contents", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.sourceRoot, "Default", "Preferences");
    for (const contents of ["{sensitive-synthetic-preferences", "null", "[]"]) {
      await writeFile(file, contents);
      await assert.rejects(copyChromeProfile({ ...f, directory: "Default" }), { message: "could not read copied Chrome preferences" });
      assert.equal(await readFile(file, "utf8"), contents);
    }
  } finally { await f.close(); }
});

test("settings chooser persists a whole-run choice and rejects paths and unknown profiles", async () => {
  const f = await fixture();
  const app = await startApp({ home: f.home, port: 0, chromeProfilesRoot: f.sourceRoot });
  const base = `http://127.0.0.1:${app.port}`;
  const put = (body: object) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const profiles = await fetch(`${base}/api/chrome-profiles`).then((response) => response.json()) as { profiles: { email: string }[] };
    assert.equal(profiles.profiles[0].email, "a@example.test");
    assert.equal(app.library.settings().pageEngine ?? "old", "old");
    assert.equal((await put({ pageEngine: "agent-browser" })).status, 400);
    assert.equal((await put({ chromeProfile: "../outside" })).status, 400);
    assert.equal((await put({ pageEngine: "unknown" })).status, 400);
    assert.equal((await put({ pageEngine: "agent-browser", chromeProfile: "Default" })).status, 200);
    assert.equal(app.library.settings().pageEngine, "agent-browser");
    for (const driver of [undefined, "extension"] as const) {
      app.library.save(testWorkflow({ schema: "bao.workflow/v4", id: `wf-${driver}`, name: "Fixture", driver, startUrl: "https://example.test/", createdAt: 1, inputs: [], steps: [{ id: "s0", index: 0, timeoutMs: 1000, caption: { text: "Enter" }, action: "key", key: "Enter" }] }));
      for (const guide of [false, true]) {
        const response = await fetch(`${base}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: `wf-${driver}`, guide }) });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: string }).error, "pass-through sessions do not support saved workflow replay");
      }
    }
    assert.equal(app.library.settings().keepAgentBrowserOpen ?? false, false);
    assert.equal((await put({ keepAgentBrowserOpen: true })).status, 200);
    assert.equal(app.library.settings().keepAgentBrowserOpen, true);
    assert.equal((await put({ keepAgentBrowserOpen: "true" })).status, 400);
    assert.equal((await put({ keepAgentBrowserOpen: false })).status, 200);
    assert.equal(app.library.settings().keepAgentBrowserOpen, false);
    assert.equal(app.library.settings().chromeProfile, "Default");
    assert.equal(app.library.settings().chromeProfileExtensions?.Default ?? false, false);
    assert.equal((await put({ chromeProfileExtensions: { Default: true } })).status, 200);
    assert.equal((await put({ chromeProfile: "Profile 1", chromeProfileExtensions: { "Profile 1": false } })).status, 200);
    assert.deepEqual(app.library.settings().chromeProfileExtensions, { Default: true, "Profile 1": false });
    assert.equal((await put({ chromeProfile: "Default" })).status, 200);
    assert.equal(app.library.settings().chromeProfileExtensions?.Default, true);
    assert.equal((await put({ chromeProfileExtensions: { Default: "yes" } })).status, 400);
    assert.equal((await put({ chromeProfileExtensions: { "../outside": true } })).status, 400);
    assert.equal((await put({ chromeProfileExtensions: [] })).status, 400);
    assert.equal((await put({ chromeProfileExtensions: null })).status, 400);
    assert.equal((await fetch(`${base}/api/chrome-profiles`, { headers: { origin: "https://other.example.test" } })).status, 403);
    assert.equal((await put({ pageEngine: "old" })).status, 200);
    assert.equal(app.library.settings().pageEngine, "old");
  } finally { await app.close(); await f.close(); }
});

test("test-browser lane never lists the owner's real Chrome profiles", { skip: !process.env.BAO_TEST_BROWSER }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-chooser-test-"));
  const app = await startApp({ home: root, port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/chrome-profiles`);
    assert.deepEqual(await response.json(), { profiles: [] });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("only the copied Chrome child gets the passwd HOME; Bao's isolated HOME stays unchanged", async (t) => {
  const f = await fixture();
  const parentHome = process.env.HOME;
  const processes = require("node:child_process") as typeof import("node:child_process");
  let observed: NodeJS.ProcessEnv | undefined;
  t.mock.method(processes, "spawn", (_file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    observed = options.env;
    throw new Error("observed child environment without launching Chrome");
  });
  try {
    for (const open of [openCopiedChrome, openCopiedChromeForProxy]) {
      await assert.rejects(open({ ...f, directory: "Default" }), /observed child environment/);
      assert.ok(observed);
      assert.equal(observed.HOME, userInfo().homedir);
      assert.equal(observed.BAO_HEAL_CURSOR_ACCOUNT, process.env.BAO_HEAL_CURSOR_ACCOUNT);
      assert.equal(process.env.HOME, parentHome);
    }
  } finally { await f.close(); }
});

test("copied Chrome removes packed image-theme files but preserves other extensions for opt-in loading", async (t) => {
  const f = await fixture();
  const processes = require("node:child_process") as typeof import("node:child_process");
  const addonManifest = JSON.stringify({ manifest_version: 3, name: "Test addon", version: "1.0" });
  const themeManifest = JSON.stringify({ manifest_version: 3, name: "Test theme", version: "1.0", theme: { images: { theme_frame: "frame.png" } } });
  for (const directory of ["Default", "Profile 1"]) {
    for (const [id, versions, manifest] of [
      ["test-addon", ["1.0_0"], addonManifest],
      ["synthetic-theme-extension", ["1.0_0", "2.0_0"], themeManifest],
      ["inactive-theme", ["1.0_0"], themeManifest],
    ] as const) {
      for (const version of versions) {
        const dir = path.join(f.sourceRoot, directory, "Extensions", id, version);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "manifest.json"), manifest);
        if (manifest === themeManifest) {
          await writeFile(path.join(dir, "frame.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64"));
        }
      }
    }
    const oldVersion = path.join(f.sourceRoot, directory, "Extensions", "synthetic-theme-extension", "0.0_0");
    await mkdir(oldVersion);
    await writeFile(path.join(oldVersion, "manifest.json"), "");
  }
  const before = await sourceBytes(f.sourceRoot);
  const calls: string[][] = [];
  t.mock.method(processes, "spawn", (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    const dir = args.find((arg) => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    const profile = args.find((arg) => arg.startsWith("--profile-directory="))!.slice("--profile-directory=".length);
    assert.equal(readFileSync(path.join(dir, profile, "Extensions", "test-addon", "1.0_0", "manifest.json"), "utf8"), addonManifest);
    for (const id of ["synthetic-theme-extension", "inactive-theme"]) {
      assert.equal(existsSync(path.join(dir, profile, "Extensions", id)), false);
    }
    const prefs = JSON.parse(readFileSync(path.join(dir, profile, "Preferences"), "utf8")) as TestPreferences;
    if (profile === "Default") {
      assert.deepEqual(prefs.session, f.preferences.session);
      assert.equal(readFileSync(path.join(dir, profile, "Sessions", "tab"), "utf8"), "synthetic-saved-tabs");
      assert.equal(readFileSync(path.join(dir, profile, "Session Storage", "entry"), "utf8"), "synthetic-per-tab-token");
      for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
        assert.equal(readFileSync(path.join(dir, profile, name), "utf8"), "synthetic-legacy-session");
      }
    } else {
      assert.equal(existsSync(path.join(dir, "Default")), false);
    }
    assert.equal(prefs.extensions.theme.id, "user_color_theme_id");
    throw new Error("observed extension flags without launching Chrome");
  });
  try {
    for (const directory of ["Default", "Profile 1"]) {
      for (const loadExtensions of [undefined, false, true]) {
        await assert.rejects(openCopiedChrome({ ...f, directory, loadExtensions }), /observed extension flags/);
      }
    }
    assert.deepEqual(await sourceBytes(f.sourceRoot), before);
    assert.deepEqual(calls.map((args) => args.includes("--disable-extensions")), [true, true, false, true, true, false]);
    for (const args of calls) {
      assert.ok(args.includes("--disable-sync"));
      assert.equal(args.filter((arg) => arg === "--restore-last-session").length, 1);
      assert.equal(args.includes("--enable-automation"), false);
    }
  } finally { await f.close(); }
});

test("copied Chrome reaches launch with empty, truncated, missing, or unreadable manifests", async (t) => {
  const f = await fixture();
  const processes = require("node:child_process") as typeof import("node:child_process");
  const truncated = '{"name":"sensitive-synthetic-manifest",';
  for (const directory of ["Default", "Profile 1"]) {
    const extensionDir = path.join(f.sourceRoot, directory, "Extensions", "broken-addon");
    for (const version of ["empty", "truncated", "missing", "unreadable"]) {
      await mkdir(path.join(extensionDir, version), { recursive: true });
    }
    await writeFile(path.join(extensionDir, "empty", "manifest.json"), "");
    await writeFile(path.join(extensionDir, "truncated", "manifest.json"), truncated);
    await mkdir(path.join(extensionDir, "unreadable", "manifest.json"));
  }
  const before = await sourceBytes(f.sourceRoot);
  const calls: boolean[] = [];
  t.mock.method(processes, "spawn", (_file: string, args: readonly string[]) => {
    const dir = args.find((arg) => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    const profile = args.find((arg) => arg.startsWith("--profile-directory="))!.slice("--profile-directory=".length);
    const extensionDir = path.join(dir, profile, "Extensions", "broken-addon");
    assert.equal(readFileSync(path.join(extensionDir, "empty", "manifest.json"), "utf8"), "");
    assert.equal(readFileSync(path.join(extensionDir, "truncated", "manifest.json"), "utf8"), truncated);
    assert.equal(existsSync(path.join(extensionDir, "unreadable", "manifest.json")), true);
    calls.push(args.includes("--disable-extensions"));
    throw new Error("reached launch despite invalid manifests");
  });
  try {
    for (const directory of ["Default", "Profile 1"]) {
      for (const loadExtensions of [false, true]) {
        await assert.rejects(openCopiedChrome({ ...f, directory, loadExtensions }), { message: "reached launch despite invalid manifests" });
      }
    }
    assert.deepEqual(calls, [true, false, true, false]);
    assert.deepEqual(await sourceBytes(f.sourceRoot), before);
  } finally { await f.close(); }
});

test("copied Chrome restores two tabs through delayed product startup while source Chrome stays open", { skip: !process.env.BAO_TEST_BROWSER }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-copy-restore-test-"));
  const sourceRoot = path.join(root, "source");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Saved tab fixture</title><h1>Saved tab fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let source: BrowserContext | undefined;
  let restored: BrowserContext | undefined;
  let opened: Awaited<ReturnType<typeof openCopiedChrome>> | undefined;
  try {
    source = await launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
    const first = source.pages()[0]!;
    await first.goto(url);
    await first.evaluate(() => sessionStorage.setItem("tabToken", "alpha"));
    const second = await source.newPage();
    await second.goto(url);
    await second.evaluate(() => sessionStorage.setItem("tabToken", "beta"));
    await source.close();
    source = undefined;
    const file = path.join(sourceRoot, "Default", "Preferences");
    const prefs = JSON.parse(await readFile(file, "utf8")) as TestPreferences;
    prefs.session = { ...prefs.session, restore_on_startup: 5 };
    await writeFile(file, JSON.stringify(prefs));
    source = await launchOwnedChrome({ userDataDir: sourceRoot, headless: true,
      preserveRestoredTabs: true, loadExtensions: false });
    const values = async (context: BrowserContext) => Promise.all(context.pages().filter((page) => page.url() === url)
      .map((page) => page.evaluate(() => sessionStorage.getItem("tabToken"))));
    const sourceDeadline = Date.now() + 15000;
    let sourcePrefs: TestPreferences;
    do {
      sourcePrefs = JSON.parse(await readFile(file, "utf8")) as TestPreferences;
      if (sourcePrefs.profile.exit_type === "Crashed" && (await values(source)).length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < sourceDeadline);
    assert.equal(sourcePrefs.profile.exit_type, "Crashed");
    assert.deepEqual((await values(source)).sort(), ["alpha", "beta"]);
    const launches = require("../../src/launch") as typeof import("../../src/launch");
    const launch = launches.launchOwnedChrome;
    t.mock.method(launches, "launchOwnedChrome", (options: Parameters<typeof launch>[0]) =>
      launch({ ...options, headless: process.env.BAO_HEADED === "0" ? true : options.headless }));
    const connect = chromium.connectOverCDP.bind(chromium);
    let emptyReads = 0;
    t.mock.method(chromium, "connectOverCDP", async (...args: Parameters<typeof connect>) => {
      const browser = await connect(...args);
      restored = browser.contexts()[0]!;
      const pages = restored.pages.bind(restored);
      const visibleAt = Date.now() + 6000;
      t.mock.method(restored, "pages", () => {
        if (Date.now() >= visibleAt) return pages();
        emptyReads++;
        return [];
      });
      return browser;
    });
    opened = await openCopiedChrome({ sourceRoot, directory: "Default", home: path.join(root, "home") });
    assert.ok(emptyReads > 0);
    assert.ok(restored);
    const selected = await restored.newCDPSession(restored.pages()[0]!);
    const { targetInfos } = await selected.send("Target.getTargets");
    assert.ok(targetInfos.some((target) => target.targetId === opened!.parkedTargetId && target.url === url));
    await selected.detach();
    const deadline = Date.now() + 5000;
    while ((await values(restored)).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual((await values(restored)).sort(), ["alpha", "beta"]);
    assert.equal(restored.pages().length, 2);
    assert.deepEqual((await values(source)).sort(), ["alpha", "beta"]);
    sourcePrefs = JSON.parse(await readFile(file, "utf8")) as TestPreferences;
    assert.equal(sourcePrefs.profile.exit_type, "Crashed");
    assert.equal(sourcePrefs.session?.restore_on_startup ?? 5, 5, "Chrome may omit the default new-tab startup preference");
    const browserClosed = restored.waitForEvent("close", { timeout: 5000 });
    await Promise.all(restored.pages().map((page) => page.close()));
    await browserClosed;
    await opened.closed;
  } finally {
    await restored?.close();
    await source?.close();
    await opened?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("copy refuses links rather than following them into another profile", async () => {
  const f = await fixture();
  try {
    await symlink(path.join(f.sourceRoot, "Profile 1"), path.join(f.sourceRoot, "Default", "linked"));
    await assert.rejects(copyChromeProfile({ ...f, directory: "Default" }), /refused a link/);
    assert.deepEqual(await readdir(path.join(f.sourceRoot, "Profile 1")), []);
  } finally { await f.close(); }
});
