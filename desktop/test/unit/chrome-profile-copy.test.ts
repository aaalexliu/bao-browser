import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyChromeProfile, listChromeProfiles } from "../../src/engines/chrome-profile-copy";
import { startApp } from "../../src/app/server";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bao-copy-test-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default", "Cache"), { recursive: true });
  await mkdir(path.join(sourceRoot, "Default", "Sessions"), { recursive: true });
  await mkdir(path.join(sourceRoot, "Profile 1"), { recursive: true });
  const local = { os_crypt: { encrypted_key: "synthetic-not-a-real-key" }, profile: { last_used: "Profile 1", info_cache: {
    Default: { name: "Profile A", user_name: "a@example.test" }, "Profile 1": { name: "Profile B", user_name: "b@example.test" }, "../outside": { name: "bad" },
  } } };
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify(local));
  await writeFile(path.join(sourceRoot, "Default", "Cookies"), "synthetic-cookie-file");
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1 } }));
  await writeFile(path.join(sourceRoot, "Default", "Cache", "entry"), "disposable");
  await writeFile(path.join(sourceRoot, "Default", "Sessions", "tab"), "do-not-restore");
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    await writeFile(path.join(sourceRoot, "Default", name), "do-not-copy-session-data");
  }
  return { root, sourceRoot, home: path.join(root, "home"), close: () => rm(root, { recursive: true, force: true }) };
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
    const before = await readFile(path.join(f.sourceRoot, "Local State"));
    const first = await copyChromeProfile({ ...f, directory: "Default" });
    privateRoot = path.dirname(first.userDataDir);
    assert.equal((await stat(first.userDataDir)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(first.userDataDir, "Default", "Cookies"), "utf8"), "synthetic-cookie-file");
    assert.deepEqual((await readdir(path.join(first.userDataDir, "Default"))).sort(), ["Cookies", "Preferences"]);
    await assert.rejects(stat(path.join(first.userDataDir, "Profile 1")), /ENOENT/);
    const state = JSON.parse(await readFile(path.join(first.userDataDir, "Local State"), "utf8"));
    assert.equal(state.profile.last_used, "Default");
    assert.deepEqual(Object.keys(state.profile.info_cache), ["Default"]);
    assert.equal(state.os_crypt.encrypted_key, "synthetic-not-a-real-key");
    assert.equal(first.bytes, Buffer.byteLength("synthetic-cookie-file")
      + Buffer.byteLength(await readFile(path.join(f.sourceRoot, "Default", "Preferences"), "utf8"))
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
    assert.deepEqual(await readFile(path.join(f.sourceRoot, "Local State")), before);
    assert.equal(await readFile(path.join(f.sourceRoot, "Default", "Cache", "entry"), "utf8"), "disposable");
    assert.equal(await readFile(path.join(f.sourceRoot, "Default", "Sessions", "tab"), "utf8"), "do-not-restore");
    for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
      assert.equal(await readFile(path.join(f.sourceRoot, "Default", name), "utf8"), "do-not-copy-session-data");
    }
  } finally { if (privateRoot) await rm(privateRoot, { recursive: true, force: true }); await f.close(); }
});

test("settings chooser persists a whole-run choice and rejects paths and unknown profiles", async () => {
  const f = await fixture();
  const app = await startApp({ home: f.home, port: 0, chromeProfilesRoot: f.sourceRoot, liveTarget: `throwaway:${path.join(f.root, "DevToolsActivePort")}` });
  const base = `http://127.0.0.1:${app.port}`;
  const put = (body: object) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const profiles = await fetch(`${base}/api/chrome-profiles`).then((response) => response.json());
    assert.equal(profiles.profiles[0].email, "a@example.test");
    assert.equal(app.library.settings().pageEngine ?? "old", "old");
    assert.equal((await put({ pageEngine: "agent-browser" })).status, 400);
    assert.equal((await put({ chromeProfile: "../outside" })).status, 400);
    assert.equal((await put({ pageEngine: "unknown" })).status, 400);
    assert.equal((await put({ pageEngine: "agent-browser", chromeProfile: "Default" })).status, 200);
    assert.equal(app.library.settings().pageEngine, "agent-browser");
    assert.equal(app.library.settings().chromeProfile, "Default");
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

test("copy refuses links rather than following them into another profile", async () => {
  const f = await fixture();
  try {
    await symlink(path.join(f.sourceRoot, "Profile 1"), path.join(f.sourceRoot, "Default", "linked"));
    await assert.rejects(copyChromeProfile({ ...f, directory: "Default" }), /refused a link/);
    assert.deepEqual(await readdir(path.join(f.sourceRoot, "Profile 1")), []);
  } finally { await f.close(); }
});
