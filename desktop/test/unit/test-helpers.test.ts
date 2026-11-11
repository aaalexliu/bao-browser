import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { baoDriver, snapshotRefs } from "../helpers/driver";
import { baoFixtureEnv, syntheticChromeProfile } from "../helpers/fixtures";
import { testWorkflow } from "../support/workflow";

interface Result { isError: boolean; content: { text: string }[] }

test("snapshot refs use bracket metadata, keep duplicate labels, and leave @ for command arguments", () => {
  const snapshot = '- heading "Name" [level=1, ref=e1]\n- textbox "Name " [ref=e2]\n- button "Add blueberries" [ref=e3]\n- button "Add blueberries" [ref=e12]\n- button "No ref" @e4\n';
  assert.deepEqual(snapshotRefs(snapshot, /textbox "Name\s*"/), ["e2"]);
  assert.deepEqual(snapshotRefs(snapshot, /button "Add blueberries"/g), ["e3", "e12"]);
  assert.deepEqual(snapshotRefs(snapshot, /heading/), ["e1"]);
  assert.deepEqual(snapshotRefs(snapshot, /No ref|missing/), []);
});

test("workflow fixtures number filtered steps by position before Library.save", () => {
  const doc = testWorkflow({ steps: [0, 2, 5].map((index) => ({ id: `note-${index}`, index, timeoutMs: 0, caption: { text: "Note" }, action: "note", text: "Note" })) });
  assert.equal(doc.schema, "bao.workflow/v4");
  assert.deepEqual(doc.steps.map((step) => step.index), [0, 1, 2]);
  assert.deepEqual(doc.steps.map((step) => step.id), ["note-0", "note-2", "note-5"]);
});

test("fixture builders and the MCP driver use a synthetic profile and isolated Library", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-test-helpers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = await syntheticChromeProfile(path.join(root, "profiles"), { name: "Fixture", user_name: "fixture@example.test" });
  assert.deepEqual(JSON.parse(await readFile(path.join(profiles, "Local State"), "utf8")), { profile: { info_cache: { Default: { name: "Fixture", user_name: "fixture@example.test" } } } });
  assert.equal(await readFile(path.join(profiles, "Default", "Preferences"), "utf8"), "{}");
  const env = baoFixtureEnv({ user: root, library: path.join(root, "library"), profiles }, { ...process.env, OPENAI_API_KEY: "fixture-only", BAO_HEADED: "1" });
  assert.equal(env.HOME, root);
  assert.equal(env.BAO_HOME, path.join(root, "library"));
  assert.equal(env.BAO_AGENT_BROWSER_PROFILE_ROOT, profiles);
  assert.equal(env.BAO_CHROME_USER_DATA, profiles);
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(env.NODE_OPTIONS?.includes("connection-guard.cjs"));
  assert.ok(env.BAO_TEST_BROWSER);
  const driver = baoDriver<Result>(env, 10_000);
  t.after(() => driver.close());
  await driver.initialize();
  const [first, second] = await Promise.all([
    driver.tool("get_run", { run_id: "missing-first" }),
    driver.tool("get_run", { run_id: "missing-second" }),
  ]);
  assert.equal(first.isError, true);
  assert.equal(second.isError, true);
  assert.match(first.content[0]!.text, /run not found/);
  assert.match(second.content[0]!.text, /run not found/);
  await driver.close();
  await driver.close();
  await assert.rejects(driver.request("tools/list"), /MCP exited 0/);
});
