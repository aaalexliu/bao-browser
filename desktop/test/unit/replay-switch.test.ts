import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { INSTRUCTIONS, REPLAY_WORDING, TOOLS } from "../../src/mcp/server";
import { testChromium } from "../../src/test-browser";
import { Library, REPLAY_OFF } from "../../src/v1/store";
import { baoDriver } from "../helpers/driver";
import { baoFixtureEnv, syntheticChromeProfile } from "../helpers/fixtures";
import { scaledMs } from "../runtime";
import { testWorkflow } from "../support/workflow";

interface Reply {
  instructions?: string;
  tools?: { name: string; description: string }[];
  content?: { text: string }[];
  isError?: boolean;
}

const REPLAY_TOOL_NAMES = ["search_workflows", "describe_workflow", "run_workflow"];
const FIRST_RUN_TOOL_NAMES = ["get_run", "list_runs", "agent_browser", "finish_task"];

/** A home that has saved no Replay choice, in a process the test runner's BAO_REPLAY does not reach. */
async function freshHome(t: test.TestContext, name: string): Promise<{ root: string; library: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = path.join(root, "library");
  await mkdir(path.join(root, "user"));
  const env = baoFixtureEnv({ user: path.join(root, "user"), library, profiles: await syntheticChromeProfile(path.join(root, "profiles"), { name: "Fixture" }) });
  delete env.BAO_REPLAY;
  return { root, library, env };
}

test("bao mcp lists no workflow tool and says nothing of replay until the Replay switch is on", { timeout: scaledMs(60_000) }, async (t) => {
  const home = await freshHome(t, "bao-replay-switch-mcp-");
  const mcp = baoDriver<Reply>(home.env);
  t.after(() => mcp.close());
  const hello = await mcp.initialize();
  const listed = (await mcp.request("tools/list")).tools!;
  assert.deepEqual(listed.map((tool) => tool.name), FIRST_RUN_TOOL_NAMES);
  assert.doesNotMatch(JSON.stringify(listed) + hello.instructions, /workflow|replay/i);

  new Library(home.library).save(testWorkflow({ id: "saved", name: "Saved workflow" }));
  for (const name of REPLAY_TOOL_NAMES) {
    const refused = await mcp.request("tools/call", { name, arguments: { id: "saved", query: "Saved" } });
    assert.equal(refused.isError, true, name);
    assert.equal((JSON.parse(refused.content![0]!.text) as { error: string }).error, REPLAY_OFF, name);
  }

  new Library(home.library).updateSettings({ replay: true });
  assert.deepEqual((await mcp.request("tools/list")).tools, TOOLS);
  const found = await mcp.request("tools/call", { name: "search_workflows", arguments: { query: "Saved" } });
  assert.equal((JSON.parse(found.content![0]!.text) as { hits: { id: string }[] }).hits[0]?.id, "saved");

  const on = baoDriver<Reply>(home.env);
  t.after(() => on.close());
  assert.equal((await on.initialize()).instructions, INSTRUCTIONS);
});

test("each replay sentence the off wording replaces is in a tool description or the instructions", () => {
  const read = JSON.stringify(TOOLS.map((tool) => [tool.description, tool.inputSchema])) + JSON.stringify(INSTRUCTIONS);
  for (const [on] of REPLAY_WORDING) assert.ok(read.includes(JSON.stringify(on).slice(1, -1)), on);
});

test("the app shows no replay entry until the Replay switch in Settings is on", { timeout: scaledMs(90_000) }, async (t) => {
  const home = await freshHome(t, "bao-replay-switch-app-");
  const saved = { HOME: process.env.HOME, BAO_REPLAY: process.env.BAO_REPLAY };
  process.env.HOME = home.env.HOME;
  delete process.env.BAO_REPLAY;
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const app = await startApp({ home: home.library, extensionHost: false, chromeProfilesRoot: path.join(home.root, "profiles") });
  t.after(() => app.close());
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  t.after(() => browser.close());

  app.library.save(testWorkflow({ id: "wf", name: "Saved workflow" }));
  app.library.saveRun({ id: "replayed", workflowId: "wf", status: "passed", at: 1, steps: [{ id: "s1", status: "passed" }], heals: [{ id: "heal-1", failedStep: { id: "s1", index: 0 } }] });
  const origin = `http://127.0.0.1:${app.port}`;
  const post = (route: string, body: unknown) => fetch(origin + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.setDefaultTimeout(scaledMs(8_000));
  const places = () => page.locator("#rail nav button span:first-of-type").allInnerTexts();
  const paletteLabels = async () => {
    await page.keyboard.press("Control+k");
    const labels = await page.locator("#palette-list [data-command]").allInnerTexts();
    await page.keyboard.press("Control+k");
    return labels.join("\n");
  };

  await page.goto(origin);
  await page.locator("#run-receipt").waitFor();
  assert.deepEqual(await places(), ["Runs", "Settings"]);
  assert.equal(await page.locator(".runs-record").count(), 0);
  assert.equal(await page.locator("#attention").getAttribute("data-count"), "0");
  assert.equal(await page.locator("#run-actions, [data-screen=heals], [data-heal], [data-open-workflow]").count(), 0);
  assert.doesNotMatch(await paletteLabels(), /Saved workflow|Library|Capture|Teach|Replay|Heals/);
  for (const [route, body] of [["/api/replay", { id: "wf", args: {} }], ["/api/sessions", { url: origin }], ["/api/open", { link: "bao://workflow/wf" }]] as const) {
    const refused = await post(route, body);
    assert.equal(refused.status, 403, route);
    assert.equal((await refused.json() as { error: string }).error, REPLAY_OFF, route);
  }

  await page.locator("#rail [data-place=settings]").click();
  const toggle = page.locator("#replay-switch");
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await page.locator("#replay-state").innerText(), "Off");
  assert.deepEqual(await page.locator("#settings .settings-heading").allInnerTexts(), ["Mac permissions", "Logins", "Replay"]);

  await toggle.click();
  await page.locator("#rail [data-place=workflows]").waitFor();
  assert.equal(await page.locator("#replay-state").innerText(), "On");
  assert.deepEqual(await page.locator("#settings .settings-heading").allInnerTexts(), ["Runs and heals", "Mac permissions", "Remote access", "Logins", "AI help", "Replay"]);
  assert.equal((JSON.parse(await readFile(path.join(home.library, "settings.json"), "utf8")) as { replay?: boolean }).replay, true);
  assert.match(await paletteLabels(), /Run Saved workflow/);
  await page.locator("#rail [data-place=runs]").click();
  await page.locator(".runs-record").waitFor();
  await page.locator('#runs [data-heal="heal-1"]').waitFor();
  assert.equal(await page.locator("#attention").getAttribute("data-count"), "1");
  await page.locator('#runs [data-open-run="replayed"]').click();
  await page.locator("#run-actions").waitFor({ state: "attached" });
  await page.locator("#rail [data-place=workflows]").click();
  await page.locator('[data-open-workflow="wf"]').waitFor();

  await page.locator("#rail [data-place=settings]").click();
  await page.locator("#replay-switch").click();
  await page.locator("#rail [data-place=workflows]").waitFor({ state: "detached" });
  assert.deepEqual(await places(), ["Runs", "Settings"]);
  assert.equal((await post("/api/replay", { id: "wf", args: {} })).status, 403);
  assert.equal((await post("/api/open", { link: "bao://receipt/replayed" })).status, 200);
});
