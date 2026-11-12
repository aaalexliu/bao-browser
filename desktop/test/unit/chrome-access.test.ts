import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { agentsNote, askedApp, chromeDenied, ChromeFolderDenied, chromeFolderAccess, FILES_AND_FOLDERS_PANE } from "../../src/chrome-access";
import { endpointFromVersion, listenPid, parseListenPorts } from "../../src/cdp-live/endpoint";
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

test("a refused read names the app macOS blocked and does not ask for a switch", () => {
  const file = "/Users/owner/Library/Application Support/Google/Chrome/DevToolsActivePort";
  const blocked = (reason: string, env: NodeJS.ProcessEnv) => new ChromeFolderDenied(reason, file, env).message;
  assert.equal(blocked("EPERM", BAO),
    `macOS blocked Bao from reading Chrome's data (EPERM on ${file}).`);
  assert.equal(blocked("EPERM", CHATGPT),
    `macOS blocked ChatGPT from reading Chrome's data (EPERM on ${file}).`);
  assert.equal(blocked("EACCES", {}),
    `macOS blocked the app that started Bao from reading Chrome's data (EACCES on ${file}).`);
  assert.doesNotMatch(blocked("EPERM", BAO), /Turn on|Files & Folders/);
  assert.doesNotMatch(blocked("EPERM", CHATGPT), /Turn on|Files & Folders/);
});

test("a certificate-signed refusal names Bao's switch and opens Files & Folders once", () => {
  const file = "/Users/owner/Library/Application Support/Google/Chrome/DevToolsActivePort";
  const signed = new ChromeFolderDenied("EPERM", file, { ...BAO, BAO_CERT_SIGNED: "1" });
  assert.equal(signed.message,
    `macOS blocked Bao from reading Chrome's data (EPERM on ${file}). Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome, then try again.`);
  const opened: string[] = [];
  signed.present((url) => opened.push(url));
  signed.present((url) => opened.push(url));
  assert.deepEqual(opened, [FILES_AND_FOLDERS_PANE]);
  const adHoc = new ChromeFolderDenied("EPERM", file, CHATGPT);
  adHoc.present((url) => opened.push(`again:${url}`));
  assert.deepEqual(opened, [FILES_AND_FOLDERS_PANE]);
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
  assert.match(access.state === "denied" ? access.message : "", /^macOS blocked Bao from reading Chrome's data \(EACCES on .+\)\.$/);
  assert.doesNotMatch(access.state === "denied" ? access.message : "", /Turn on|Files & Folders/);
});

test("the profile question and a Chrome copy stop with the switch when Chrome's folder is refused", async (t) => {
  const root = await refusedRoot(t);
  await assert.rejects(chooseChromeProfile(root, undefined), (error: unknown) => error instanceof ChromeFolderDenied && error.file === root);
  const home = await mkdtemp(path.join(tmpdir(), "bao-chrome-refused-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(copyChromeProfile({ sourceRoot: root, directory: "Default", home }), ChromeFolderDenied);
});

test("a listening port is a debug endpoint only when /json/version says so", () => {
  const line = "Google 15133 alexliu 233u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)\nGoogle 15133 alexliu 12u IPv4 0x1 0t0 TCP *:443 (LISTEN)\nGoogle 9 alexliu 1u IPv4 0x1 0t0 TCP 127.0.0.1:1 (LISTEN)\n";
  assert.deepEqual(parseListenPorts(line, 15133), [9222]);
  assert.equal(endpointFromVersion(9222, 404, "")?.browserPath, "/devtools/browser");
  assert.equal(endpointFromVersion(9222, 200, JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }))?.browserPath, "/devtools/browser/abc");
  assert.equal(endpointFromVersion(9222, 404, "<html>not the debug server</html>"), undefined);
  assert.equal(endpointFromVersion(9222, 200, "not json"), undefined);
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
