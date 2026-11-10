import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { McpClient, type McpResult } from "../../src/eval/mcp-client";
import { testChromium as chromium } from "../../src/test-browser.js";
import { Library } from "../../src/v1/store";
import { startExperianFixture } from "../experian/fixture";
import { laneChildEnv } from "../runtime";

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

test("Experian-shaped pass-through hands sign-in and bot walls to the owner and follows redirects", { skip: !binary, timeout: 60_000 }, async (t) => {
  const started = performance.now();
  const root = await mkdtemp(path.join(tmpdir(), "bao-experian-proxy-"));
  const fixture = await startExperianFixture({ loopbackHttp: true });
  const source = path.join(root, "source");
  const home = path.join(root, "library");
  await mkdir(path.join(source, "Default"), { recursive: true });
  await writeFile(path.join(source, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic Experian" } } } }));
  await writeFile(path.join(source, "Default", "Preferences"), "{}");
  const env = { ...laneChildEnv("hermetic", process.env), HOME: root, BAO_HOME: home, BAO_AGENT_BROWSER: binary, BAO_AGENT_BROWSER_PROFILE_ROOT: source };
  const client = McpClient.start(env);
  let owner: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  // Like an agent, the test sends back the run id from its latest agent_browser result.
  let run: string | undefined;
  const command = async (name: string, args: string[] = []) => {
    const result = await client.call("agent_browser", { command: name, args, ...(name === "open" ? { browser: "copy" } : {}),
      ...(name === "wait_for_owner" || name === "close") && run ? { run_id: run } : {} });
    const named = result.structuredContent?.run_id;
    run = (typeof named === "string" ? named : /^Run (\S+)$/m.exec(result.text)?.[1]) ?? run;
    return result;
  };
  const outcome = (result: McpResult) => {
    assert.equal(result.isError, false, result.text);
    return result.structuredContent?.outcome;
  };
  try {
    await client.handshake();
    const signin = await command("open", [fixture.url("/owner/start")]);
    assert.equal(outcome(signin), "halted");
    assert.match(signin.text, /sign in|sign-in/);

    const namespace = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 20);
    const copies = path.join(tmpdir(), `bao-profile-copies-${namespace}`);
    const [copy] = await readdir(copies);
    assert.ok(copy);
    const endpoint = await readDevToolsActivePort(path.join(copies, copy, "DevToolsActivePort"));
    owner = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const page = owner.contexts()[0]!.pages().find((page) => page.url().includes("/owner/sign-in"));
    assert.ok(page, "the sign-in redirect leaves the owned browser open for the owner");
    await page.goto(fixture.url("/seed"));
    await page.goto(fixture.url("/member"));
    assert.equal(outcome(await command("wait_for_owner", ["2000"])), "ready");
    const resumed = await command("snapshot", ["-i"]);
    assert.equal(resumed.isError, false, resumed.text);
    assert.match(resumed.text, /View full credit report/);

    const redirected = await command("open", [fixture.url("/member/account-redirect")]);
    assert.equal(redirected.isError, false, redirected.text);
    assert.equal(page.url(), fixture.url("/account"));
    assert.match(redirected.text, /\/account/);

    for (const wall of ["/member/bot", "/owner/check"]) {
      await page.goto(fixture.url(wall));
      assert.equal(outcome(await command("snapshot", ["-i"])), "halted", wall);
      await page.goto(fixture.url("/member"));
      assert.equal(outcome(await command("wait_for_owner", ["2000"])), "ready", wall);
    }
    assert.equal((await command("close")).isError, false);
    assert.ok(fixture.requests.some((request) => request.path === "/owner/sign-in"));
    assert.ok(fixture.requests.some((request) => request.path === "/account"));
    assert.equal(fixture.requests.filter((request) => request.path === "/member/bot").length, 1, "the proxy does not retry the bot wall");
    const library = new Library(home);
    assert.equal(library.list().workflows.length, 1, "completed owner handoffs preserve the saved navigation workflow");
    assert.deepEqual(library.list().workflows[0]!.steps.map((step) => step.action), ["navigate"]);
    assert.equal(library.listRuns().length, 1, "the same session keeps its run receipt");
  } finally {
    await owner?.close().catch(() => undefined);
    await client.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    t.diagnostic(`Experian pass-through wall time: ${(performance.now() - started).toFixed(0)} ms`);
  }
});
