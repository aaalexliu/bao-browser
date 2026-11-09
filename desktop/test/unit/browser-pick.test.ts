import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { chooseChromeProfile, ChromeProfileQuestion, pickLine, signInLine } from "../../src/engines/browser-pick";
import { openWorkflowBrowser } from "../../src/engines/workflow-browser";
import { chromeProfiles, type ProfileNames } from "../support/chrome-profiles";

async function chromeRoot(t: TestContext, profiles: ProfileNames): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bao-pick-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return chromeProfiles(root, profiles);
}

test("one Chrome profile is used and named as the only profile", async (t) => {
  const root = await chromeRoot(t, { "Profile 3": { name: "Alex", user_name: "alex@example.test" } });
  assert.deepEqual(await chooseChromeProfile(root, undefined, "Default"),
    { directory: "Profile 3", name: "Alex", email: "alex@example.test", root, why: "the only profile" });
});

test("several Chrome profiles and none named is a question that lists each folder, name, and email and marks the Settings pick", async (t) => {
  const root = await chromeRoot(t, {
    Default: { name: "Alex", user_name: "alex@example.test" },
    "Profile 2": { name: "Work", user_name: "alex@work.test" },
    "Profile 5": { name: "Shopping" },
  });
  const question = await chooseChromeProfile(root, undefined, "Profile 2").then(() => undefined, (error: unknown) => error);
  assert.ok(question instanceof ChromeProfileQuestion);
  assert.equal(question.message, `Chrome has 3 profiles in ${root}, so Bao opened nothing. Choose one: "Default" (Alex, alex@example.test); "Profile 5" (Shopping); "Profile 2" (Work, alex@work.test), picked in Bao Settings.`);
  assert.equal(question.retry({ command: "open", args: ["https://example.test/"], browser: "bao" }),
    'To continue, call agent_browser again with the folder of the profile you choose: {"command":"open","args":["https://example.test/"],"browser":"bao","profile":"Profile 2"}');
  const unpicked = await chooseChromeProfile(root, undefined).then(() => undefined, (error: unknown) => error);
  assert.ok(unpicked instanceof ChromeProfileQuestion);
  assert.doesNotMatch(unpicked.message, /picked in Bao Settings/);
  assert.match(unpicked.retry({ command: "open" }), /"profile":"Default"/);
});

test("a named Chrome profile is used even when Settings picked another, and an unknown name lists the valid ones", async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex", user_name: "alex@example.test" }, "Profile 2": { name: "Work" } });
  assert.deepEqual(await chooseChromeProfile(root, { directory: "Default", by: "agent" }, "Profile 2"),
    { directory: "Default", name: "Alex", email: "alex@example.test", root, why: "named by the agent" });
  assert.equal((await chooseChromeProfile(root, { directory: "Profile 2", by: "settings" })).why, "picked in Bao Settings");
  await assert.rejects(chooseChromeProfile(root, { directory: "Profile 9", by: "agent" }),
    { message: `Chrome has no profile "Profile 9" in ${root}. Choose one of: "Default" (Alex, alex@example.test); "Profile 2" (Work).` });
  await assert.rejects(chooseChromeProfile(root, { directory: "Profile 9", by: "settings" }), /Pick it again in Bao Settings\.$/);
});

test("an unreadable Chrome root is an error, never a silent Default", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-pick-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(chooseChromeProfile(root, undefined), new RegExp(`^Error: Bao could not read Chrome's profiles in ${root}`));
});

test("the route line names the route, Chrome app, user-data-dir, profile, and why", () => {
  const profile = { directory: "Default", name: "Alex", email: "alex@example.test", root: "/Chrome", why: "named by the agent" as const };
  assert.equal(pickLine({ route: "bao", why: "the default", chrome: "/Chrome.app/Chrome", userDataDir: "/Bao/agent-browser-profile", profile }),
    'Browser: Bao profile, the default. Chrome app: /Chrome.app/Chrome. User data: /Bao/agent-browser-profile. Sign-ins come from Chrome profile "Default" (Alex, alex@example.test) in /Chrome, named by the agent.');
  assert.equal(pickLine({ route: "copy", why: "named by the agent", chrome: "/Chrome.app/Chrome", userDataDir: "/tmp/run-1", profile: { ...profile, why: "the only profile" } }),
    'Browser: Chrome copy, named by the agent. Chrome app: /Chrome.app/Chrome. User data: /tmp/run-1, a copy of Chrome profile "Default" (Alex, alex@example.test) in /Chrome, the only profile.');
  assert.equal(pickLine({ route: "current", why: "fallback after a sign-in wall", chrome: "/Chrome.app/Chrome", userDataDir: "/Chrome", profile, background: false }),
    'Browser: Running Chrome over remote debugging, fallback after a sign-in wall. Chrome app: /Chrome.app/Chrome. User data: /Chrome. Profile: "Default" (Alex, alex@example.test) in /Chrome, named by the agent. Chrome opened Bao\'s task tab in front, in a window of that profile.');
  assert.equal(pickLine({ route: "extension", why: "named by the agent" }),
    "Browser: Running Chrome through the Bao extension, named by the agent. It runs in the Chrome profile where the Bao extension is linked.");
});

test("a saved workflow on a Chrome copy or Running Chrome uses the Settings pick, and with several profiles and none picked opens nothing", async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 2": { name: "Work" } });
  for (const browser of ["copy", "current"] as const) {
    await assert.rejects(openWorkflowBrowser({ browser, home: root, site: "about:blank", sourceRoot: root }),
      new RegExp(`^Error: Chrome has 2 profiles in ${root}, so Bao opened nothing\\. .* Pick one in Bao Settings under Technical details, Page engine, Chrome profile, then run the workflow again\\.$`));
    await assert.rejects(openWorkflowBrowser({ browser, home: root, site: "about:blank", sourceRoot: root, directory: "Profile 9" }), /Pick it again in Bao Settings\.$/);
  }
});

test("the sign-in import line says what Bao read and wrote, a wall retry, or why it could not read the profile", () => {
  const origin = "https://www.nytimes.com";
  assert.equal(signInLine({ origin, found: 12, cookies: 3, storage: 0 }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default": read 12 site cookies, wrote 3 new or changed cookies and 0 storage items into Bao\'s profile.');
  assert.equal(signInLine({ origin, found: 1, cookies: 1, storage: 1, retry: true }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default", again at the sign-in wall: read 1 site cookie, wrote 1 new or changed cookie and 1 storage item into Bao\'s profile.');
  assert.equal(signInLine({ origin, found: 0, cookies: 0, storage: 0 }, "Profile 2"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Profile 2": the profile has no cookies for this site.');
  assert.equal(signInLine({ origin, found: 0, cookies: 0, storage: 0, error: "EPERM: operation not permitted, scandir '/Chrome/Default/Local Storage/leveldb'" }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default" failed: EPERM: operation not permitted, scandir \'/Chrome/Default/Local Storage/leveldb\'. Bao\'s profile kept its saved sign-ins.');
});
