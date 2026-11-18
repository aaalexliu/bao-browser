import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { triedPickLine, workflowChromeRoot } from "../../src/engines/workflow-browser";
import { pinTestBrowser, resolveNormalChrome } from "../../src/launch";
import { runWorkflow } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";
import { chromeProfiles } from "../support/chrome-profiles";
import { testWorkflow } from "../support/workflow";

test("a failed profile pick names the production Chrome root, and run_workflow keeps the test browser pin", async (t) => {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-prod-pick-")), {
    Default: { name: "Alex", user_name: "alex@example.test" },
    "Profile 2": { name: "Work" },
  });
  const home = await mkdtemp(path.join(tmpdir(), "bao-prod-pick-home-"));
  const previous = {
    fixture: process.env.BAO_AGENT_BROWSER_PROFILE_ROOT,
    testBrowser: process.env.BAO_TEST_BROWSER,
    chrome: process.env.BAO_CHROME_USER_DATA,
  };
  const owner = path.join(userInfo().homedir, "Library", "Application Support", "Google", "Chrome");
  t.after(async () => {
    if (previous.fixture === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
    else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = previous.fixture;
    if (previous.testBrowser === undefined) delete process.env.BAO_TEST_BROWSER;
    else process.env.BAO_TEST_BROWSER = previous.testBrowser;
    if (previous.chrome === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previous.chrome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  delete process.env.BAO_TEST_BROWSER;
  process.env.BAO_CHROME_USER_DATA = root;
  const chromeRoot = path.resolve(root);
  const installed = resolveNormalChrome();
  const production = (route: string, folder: string) =>
    `Browser: ${route}, named by the agent, did not open. Chrome app: ${installed}. Profile: "${folder}" in ${chromeRoot}.`;
  const pick = (browser: "copy" | "current", extra: { profile?: string; directory?: string }) =>
    ({ browser, home, site: "about:blank", ...extra });
  assert.equal(workflowChromeRoot(pick("copy", { profile: "Profile 9" })), chromeRoot);
  assert.equal(workflowChromeRoot(pick("copy", {})).includes(owner), false);

  const named = triedPickLine(pick("copy", { profile: "Profile 9" }));
  assert.equal(named, production("Chrome copy", "Profile 9"));
  assert.equal(named.includes(owner), false);
  assert.equal(triedPickLine(pick("copy", { profile: "Profile 9", directory: "Profile 2" })), production("Chrome copy", "Profile 9"));
  const staleLine = triedPickLine(pick("current", { directory: "Profile 9" }));
  assert.equal(staleLine, production("Running Chrome over remote debugging", "Profile 9"));
  assert.equal(staleLine.includes("none chosen"), false);

  pinTestBrowser();
  assert.ok(process.env.BAO_TEST_BROWSER);
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = root;
  const library = new Library(home);
  library.save(testWorkflow({ id: "hello", startUrl: "about:blank", steps: [] }));
  const chrome = resolveNormalChrome();
  const tried = (route: string, folder: string) =>
    `Browser: ${route}, named by the agent, did not open. Chrome app: ${chrome}. Profile: "${folder}" in ${root}.`;

  const missing = await runWorkflow(library, { id: "hello", browser: "copy", profile: "Profile 9" });
  assert.equal(missing.outcome, "failed");
  assert.ok((missing.reason ?? "").includes(`Chrome has no profile "Profile 9" in ${root}`));
  assert.equal(missing.browser?.[0], tried("Chrome copy", "Profile 9"));
  assert.equal(missing.browser?.[0]?.includes(owner), false);

  library.updateSettings({ chromeProfile: "Profile 2" });
  const namedWins = await runWorkflow(library, { id: "hello", browser: "copy", profile: "Profile 9" });
  assert.equal(namedWins.browser?.[0], tried("Chrome copy", "Profile 9"));

  library.updateSettings({ chromeProfile: "Profile 9" });
  const stale = await runWorkflow(library, { id: "hello", browser: "current" });
  assert.ok((stale.reason ?? "").includes("Pick it again in Bao Settings"));
  assert.equal(stale.browser?.[0], tried("Running Chrome over remote debugging", "Profile 9"));
  assert.equal(stale.browser?.[0]?.includes("none chosen"), false);

  library.updateSettings({ chromeProfile: undefined });
  const asked = await runWorkflow(library, { id: "hello", browser: "copy" });
  assert.ok((asked.reason ?? "").includes("so Bao opened nothing"));
  assert.equal(asked.browser, undefined);
});
