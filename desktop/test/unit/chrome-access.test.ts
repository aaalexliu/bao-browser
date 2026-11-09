import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { agentsNote, askedApp, chromeDenied, ChromeFolderDenied, chromeFolderAccess } from "../../src/chrome-access";
import { listenPid } from "../../src/cdp-live/endpoint";
import { chooseChromeProfile } from "../../src/engines/browser-pick";
import { copyChromeProfile } from "../../src/engines/chrome-profile-copy";
import { chromeProfiles } from "../support/chrome-profiles";

const CHATGPT = { BAO_RESPONSIBLE_EXE: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" };
const BAO = { BAO_RESPONSIBLE_EXE: "/Applications/Bao.app/Contents/MacOS/bao" };

/** A Chrome user-data-dir this process may not list, as macOS 27 refuses one without the Files & Folders switch. */
async function refusedRoot(t: TestContext): Promise<string> {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-chrome-refused-")), { Default: { name: "Owner" }, "Profile 2": { name: "Work" } });
  await chmod(root, 0o000);
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  return root;
}

test("Bao names the app macOS asks, as Files & Folders lists it", () => {
  assert.equal(askedApp(CHATGPT), "ChatGPT");
  assert.equal(askedApp(BAO), "Bao");
  assert.equal(askedApp({ BAO_RESPONSIBLE_EXE: "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app/Contents/MacOS/BaoOSHelper" }), "BaoOSHelper");
  assert.equal(askedApp({ BAO_RESPONSIBLE_EXE: "/opt/homebrew/bin/tmux" }), "tmux");
  assert.equal(askedApp({}), undefined);
});

test("a refused read names the switch and the app it belongs to", () => {
  const file = "/Users/owner/Library/Application Support/Google/Chrome/DevToolsActivePort";
  assert.equal(new ChromeFolderDenied("EPERM", file, { ...BAO, BAO_CERT_SIGNED: "1" }).message,
    `macOS did not let Bao read Google Chrome's folder (EPERM on ${file}). Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome, then try again.`);
  assert.equal(new ChromeFolderDenied("EPERM", file, BAO).message,
    `macOS did not let Bao read Google Chrome's folder (EPERM on ${file}). Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome, then try again. If it is already on, turn it off and on again: macOS ties the switch to one build of an ad-hoc signed Bao.`);
  assert.equal(new ChromeFolderDenied("EPERM", file, CHATGPT).message,
    `macOS did not let Bao read Google Chrome's folder (EPERM on ${file}). macOS asks ChatGPT, the app that started Bao. Turn on System Settings > Privacy & Security > Files & Folders > ChatGPT > Google Chrome, then try again.`);
  assert.equal(new ChromeFolderDenied("EACCES", file, {}).message,
    `macOS did not let Bao read Google Chrome's folder (EACCES on ${file}). Turn on Google Chrome for the app that started Bao, such as your terminal or agent app, under System Settings > Privacy & Security > Files & Folders, then try again.`);
});

test("whose switch agents use depends on how Bao is signed", () => {
  assert.equal(agentsNote({ ...BAO, BAO_CERT_SIGNED: "1" }), "Agents that start Bao use this switch too.");
  assert.equal(agentsNote(BAO), "Agents use the switch of the app that starts them, such as ChatGPT for Codex.");
  assert.equal(agentsNote({}), "");
});

test("only EPERM or EACCES on a file under Chrome's folder counts as refused", () => {
  const root = "/Users/owner/Library/Application Support/Google/Chrome";
  const error = (code: string, file?: string) => Object.assign(new Error(code), { code, ...file ? { path: file } : {} });
  assert.ok(chromeDenied(error("EPERM", `${root}/Default/Cookies`), root, {}) instanceof ChromeFolderDenied);
  assert.equal(chromeDenied(error("EPERM", `${root}/Default/Cookies`), root, {})?.file, `${root}/Default/Cookies`);
  assert.equal(chromeDenied(error("EACCES"), root, {})?.file, root);
  assert.equal(chromeDenied(error("EPERM", "/tmp/bao-profile-copies/run-1/Default"), root, {}), undefined, "a write into Bao's own copy is not Chrome's folder");
  assert.equal(chromeDenied(error("ENOENT", `${root}/DevToolsActivePort`), root, {}), undefined);
});

test("the access check lists Chrome's folder and says allowed, missing, or refused", async (t) => {
  const open = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-chrome-open-")));
  t.after(() => rm(open, { recursive: true, force: true }));
  assert.deepEqual(chromeFolderAccess(open, {}), { state: "allowed", root: open });
  assert.deepEqual(chromeFolderAccess(path.join(open, "absent"), {}), { state: "missing", root: path.join(open, "absent") });
  const refused = await refusedRoot(t);
  const access = chromeFolderAccess(refused, BAO);
  assert.equal(access.state, "denied");
  assert.match(access.state === "denied" ? access.message : "", /^macOS did not let Bao read Google Chrome's folder \(EACCES on .+\)\. Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome/);
});

test("the profile question and a Chrome copy stop with the switch when Chrome's folder is refused", async (t) => {
  const root = await refusedRoot(t);
  await assert.rejects(chooseChromeProfile(root, undefined), (error: unknown) => error instanceof ChromeFolderDenied && error.file === root);
  const home = await mkdtemp(path.join(tmpdir(), "bao-chrome-refused-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(copyChromeProfile({ sourceRoot: root, directory: "Default", home }), ChromeFolderDenied);
});

test("listenPid tells nothing listening apart from lsof failing", async (t) => {
  let fail: { code: unknown; stdout: string } = { code: 1, stdout: "" };
  t.mock.method(childProcess, "execFile", ((_file: string, _args: readonly string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
    callback(fail.code === 0 ? null : Object.assign(new Error(`exit ${String(fail.code)}`), { code: fail.code }), fail.stdout);
    return {} as childProcess.ChildProcess;
  }) as typeof childProcess.execFile);
  assert.equal(await listenPid(9222, "darwin"), undefined, "lsof exits 1 when nothing listens");
  fail = { code: "EPERM", stdout: "" };
  await assert.rejects(listenPid(9222, "darwin"), /^Error: Bao could not check which process listens on port 9222: exit EPERM$/);
});
