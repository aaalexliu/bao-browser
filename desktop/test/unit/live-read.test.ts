import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { parseLiveTarget } from "../../src/cdp-live/live-target";
import { LIVE_READ_LIMIT, liveReadSelector, liveReadSpec, readLiveRegion } from "../../src/cdp-live/live-read";
import { McpClient } from "../../src/eval/mcp-client";
import { openCopiedChrome } from "../../src/engines/chrome-profile-copy";
import { launchOwnedChrome, pidsForDataDir } from "../../src/launch";
import type { WorkflowOutcome } from "../../src/mcp/catalog";
import type { OutputTable } from "../../src/v1/data-steps";
import { validateWorkflow, type WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp, laneChildEnv } from "../runtime";

test("live reads record a safe region and return fresh output through MCP and the run record", { timeout: 120_000 }, async (t) => {
  const dirs = applyHermeticApp("live-read");
  let score = 742;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/auth") return res.end('<h1>Sign in</h1><label>Verification code<input autocomplete="one-time-code"></label>');
    res.end(`<!doctype html><title>Credit stand-in</title><main>
      <h1>Security freeze</h1><section id="freeze-status" aria-label="Freeze status"><h2>Freeze status</h2>
      <p>Frozen.</p><p>Social security number ***-**-6789. Score: ${score}. Balance: $412. Updated 2026-11-01.</p>
      <p>Account number</p><p>Score: ${score}. Balance: $412.</p>
      <p>Password</p><p>correct horse battery</p><p>Status: Frozen.</p>
      <p>Account number</p><p>****6789</p><p>Balance</p><p>$412</p><p>Score</p><p>${score}</p>
      <p>Your score is ${score}</p><p>Balance $412</p>
      <p>SSN: 123-45-6789</p><p>Card number: 4111 1111 1111 1111</p><p>Email: demo@example.com</p>
      <input value="field-secret"><textarea>textarea-secret</textarea><span contenteditable>editable-secret</span>
      <p hidden>hidden-secret</p><p style="display:none">display-secret</p><p aria-hidden="true">aria-secret</p>
      <script>window.secret = 'script-secret'</script></section>
      ${req.url === "/redaction" ? '<section id="credentials"><p><span>PIN:</span><strong>123456</strong></p><p>Password: hunter2</p><p>Token: supersecret</p></section>' : ""}
      <section id="long">${"Readable text. ".repeat(600)}</section>
      <div class="duplicate">One</div><div class="duplicate">Two</div></main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(url + "/redaction");
  const app = await startApp({ home: dirs.home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(dirs.home, "live.lock") });
  const pinned = process.env.BAO_TEST_BROWSER;
  const mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned ?? chromium.executablePath()), HOME: dirs.nativeHostHome, BAO_HOME: dirs.home });
  const tool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const reply = await mcp.call(name, args);
    assert.equal(reply.isError, false, reply.text);
    return JSON.parse(reply.text) as T;
  };
  type LiveReply = { session: string; outcome: { kind: string }; read?: { name: string; text: string; truncated: boolean } };
  try {
    // The page function filters credential text even when split across DOM nodes.
    const credentials = await page.evaluate(readLiveRegion, { selector: "#credentials", limit: LIVE_READ_LIMIT });
    assert.equal(credentials.text, "PIN:\n[redacted]\nPassword: [redacted]\nToken: [redacted]");
    for (const selector of [".duplicate", "#absent", "[", "input", "[hidden]"]) {
      await assert.rejects(page.evaluate(readLiveRegion, { selector, limit: LIVE_READ_LIMIT }), /ambiguous|not found|invalid read|hidden or sensitive/);
    }
    const bounded = await page.evaluate(readLiveRegion, { selector: "#long", limit: LIVE_READ_LIMIT });
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.text.length, LIVE_READ_LIMIT);
    assert.ok(bounded.text.endsWith("[truncated]"));
    assert.equal(liveReadSelector(liveReadSpec("freeze_status", "#freeze-status")), "#freeze-status");
    assert.throws(() => liveReadSpec("invalid name"), /output name/);
    assert.throws(() => liveReadSelector({ ...liveReadSpec("status"), columns: [{ name: "text", type: "text", read: "value", locators: [{ kind: "css", value: ":scope" }] }] }), /only live_read/);

    const targets = await browser.browser()!.newBrowserCDPSession();
    const pageIds = async (): Promise<string[]> => {
      const { targetInfos } = await targets.send("Target.getTargets");
      return targetInfos.filter((item) => item.type === "page").map((item) => item.targetId).sort();
    };
    const baseline = await pageIds();
    const pageSet = async (extra: number): Promise<string[]> => {
      const deadline = Date.now() + 10_000;
      let ids: string[];
      do {
        ids = await pageIds();
        if (ids.length === baseline.length + extra && baseline.every((id) => ids.includes(id))) return ids;
      } while (Date.now() < deadline);
      assert.fail(`expected baseline + ${extra} page targets; baseline=${baseline.join(",")} actual=${ids.join(",")}`);
    };
    const tools = await mcp.handshake();
    assert.ok(tools.includes("live_read"));
    const started = await tool<LiveReply>("live_session_start", { intent: "Read freeze status", url, workflowId: "wf-read-freeze" });
    assert.equal(started.outcome.kind, "applied");
    const read = await tool<LiveReply>("live_read", { name: "freeze_status", selector: "#freeze-status" });
    assert.match(read.read!.text, /Frozen\./);
    assert.match(read.read!.text, /Score: 742\. Balance: \$412\. Updated 2026-11-01\./);
    assert.equal(read.read!.text.match(/Score: 742\. Balance: \$412\./g)?.length, 2);
    assert.match(read.read!.text, /Status: Frozen\./);
    assert.match(read.read!.text, /Balance\n\$412\nScore\n742/);
    assert.match(read.read!.text, /Your score is 742\nBalance \$412/);
    for (const secret of ["6789", "123-45-6789", "4111", "correct horse battery", "demo@example.com", "field-secret", "textarea-secret", "editable-secret", "hidden-secret", "display-secret", "aria-secret", "script-secret"]) {
      assert.equal(read.read!.text.includes(secret), false, secret);
    }
    assert.equal(read.read!.truncated, false);
    const duplicate = await mcp.call("live_read", { name: "freeze_status", selector: "#freeze-status" });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.text, /already used/);
    await tool("live_stop", {});
    await pageSet(0);
    const workflow = app.library.read(started.session);
    assert.deepEqual(validateWorkflow(workflow), []);
    assert.equal(workflow.version, 3);
    assert.deepEqual(workflow.steps.map((step) => step.action), ["extract"]);
    assert.equal(JSON.stringify(workflow).includes("742"), false, "sampled text is not baked into the workflow");
    assert.equal(readFileSync(path.join(dirs.home, "live-session", "trail.jsonl"), "utf8").includes("123-45-6789"), false);

    score = 756;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/auth") return res.end('<h1>Sign in</h1><label>Verification code<input autocomplete="one-time-code"></label>');
      res.end(`<title>Credit stand-in</title><main><section id="freeze-status"><h2>Freeze status</h2>
        <p>Frozen.</p><p>Social security number ***-**-6789. Score: ${score}. Balance: $412.</p>
        <p>Account number</p><p>Score: ${score}. Balance: $412.</p>
        <p>Password</p><p>correct horse battery</p><p>Status: Frozen.</p>
        <p>Account number</p><p>****6789</p><p>Balance</p><p>$412</p><p>Score</p><p>${score}</p>
        <p>Your score is ${score}</p><p>Balance $412</p>
        <p>SSN: 123-45-6789</p></section></main>`);
    });
    const outcome = await tool<WorkflowOutcome>("run_workflow", { id: workflow.id, leaveOpen: true });
    assert.equal(outcome.outcome, "ok", JSON.stringify(outcome));
    assert.equal(outcome.pageLeftOpen, true);
    const text = (outcome.outputs![0] as OutputTable).rows[0]!.text!;
    assert.equal(text.match(/Score: 756\. Balance: \$412\./g)?.length, 2);
    assert.match(text, /Status: Frozen\./);
    assert.match(text, /Balance\n\$412\nScore\n756/);
    assert.match(text, /Your score is 756\nBalance \$412/);
    assert.match(text, /\[redacted\]/);
    for (const secret of ["6789", "correct horse battery"]) assert.equal(text.includes(secret), false, secret);
    await pageSet(1);
    assert.equal(existsSync(path.join(dirs.home, "live.lock")), false);
    const held = browser.pages().find((item) => item !== page && !item.isClosed())
      || await browser.waitForEvent("page", { timeout: 10_000 });
    // No request interception or Bao trust hooks remain on a page given back to the person.
    await held.goto(url + "/?manual=1", { timeout: 5000 });
    assert.equal(await held.evaluate(() => document.querySelectorAll("[data-bao-live]").length), 0);
    const stored = app.library.readRun(outcome.runId!);
    assert.deepEqual(stored.outputs, outcome.outputs);
    assert.equal(stored.pageLeftOpen, true);
    assert.equal(stored.modelCalls, 0);
    assert.equal(readdirSync(path.join(dirs.home, "shots", "runs", outcome.runId!)).length, 2);
    const fetched = await tool<WorkflowOutcome>("get_run", { run_id: outcome.runId });
    assert.deepEqual(fetched.outputs, outcome.outputs);
    assert.equal(fetched.pageLeftOpen, true);
    const html = await (await fetch(`http://127.0.0.1:${app.port}/api/runs/${outcome.runId}/outputs.json`)).json();
    assert.deepEqual(html, outcome.outputs);

    await held.close();
    await pageSet(0);
    const closed = await tool<WorkflowOutcome>("run_workflow", { id: workflow.id });
    assert.equal(closed.outcome, "ok", JSON.stringify(closed));
    assert.equal(closed.pageLeftOpen, undefined);
    await pageSet(0);
    const missing = structuredClone(workflow);
    missing.id = "wf-read-missing";
    missing.steps[0]!.extract!.locators = [{ kind: "css", value: "#absent" }];
    app.library.save(missing);
    const failed = await tool<WorkflowOutcome>("run_workflow", { id: missing.id, leaveOpen: true });
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.pageLeftOpen, undefined);
    await pageSet(0);

    // A copied-profile owner must not delete the profile under a retained page.
    let profileClosed = 0;
    const host = createLiveHost({ home: dirs.home, lockFile: path.join(dirs.home, "profile.lock"), selectRun: async () => ({
      target: parseLiveTarget(`throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, ""),
      engineName: "old", close: async () => { profileClosed += 1; },
    }) });
    try {
      const kept = await host.replay(workflow, {}, { leaveOpen: true });
      assert.equal(kept.pageLeftOpen, true);
      assert.equal(profileClosed, 0);
    } finally { await host.close(); }
    assert.equal(profileClosed, 1, "app shutdown cleans up the retained profile owner");
    const keptIds = await pageSet(1);
    await targets.send("Target.closeTarget", { targetId: keptIds.find((id) => !baseline.includes(id))! });
    await pageSet(0);

    const login = { ...workflow, id: "wf-read-login", startUrl: url + "/auth" };
    app.library.save(login);
    const halted = await tool<WorkflowOutcome>("run_workflow", { id: login.id, leaveOpen: true });
    assert.equal(halted.pageLeftOpen, true);
    assert.equal(halted.outcome, "needs_human", JSON.stringify(halted));
    assert.equal((halted.outputs?.[0] as OutputTable).rows.length, 0);
    await pageSet(1);
    await targets.detach();
  } finally {
    await mcp.close();
    await app.close();
    await browser.close();
  }
});

test("live reads apply only the two node-local credential rules", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("live-read-fields");
  const browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  try {
    const page = browser.pages()[0] || await browser.newPage();
    const cases: { nodes: string[]; expected: string[] }[] = [
      { nodes: ["PIN: 1234", "Score: 742"], expected: ["PIN: [redacted]", "Score: 742"] },
      { nodes: ["PIN", "Score: 742"], expected: ["PIN", "Score: 742"] },
      { nodes: ["Account number", "****6789", "Balance", "$412", "Score", "742"], expected: ["Account number", "[redacted]", "Balance", "$412", "Score", "742"] },
      { nodes: ["Social security number ***-**-6789. Score: 742. Balance: $412."], expected: ["Social security number [redacted]. Score: 742. Balance: $412."] },
      { nodes: ["Password", "correct horse battery"], expected: ["Password", "[redacted]"] },
      { nodes: ["Freeze status: Frozen"], expected: ["Freeze status: Frozen"] },
      { nodes: ["PIN: 12 34; Score: 742"], expected: ["PIN: [redacted]; Score: 742"] },
      { nodes: ["Password: correct horse\nScore: 742"], expected: ["Password: [redacted]\nScore: 742"] },
      { nodes: ["PIN:\nScore: 742"], expected: ["PIN:\nScore: 742"] },
      { nodes: ["Password", "required", "Score: 742"], expected: ["Password", "[redacted]", "Score: 742"] },
      { nodes: ["Token", "Updated: 2026-11-01", "Balance: $412"], expected: ["Token", "Updated: 2026-11-01", "Balance: $412"] },
      { nodes: ["The account number shown is ****6789. Score: 742"], expected: ["The account number [redacted]. Score: 742"] },
      { nodes: ["Token: Bearer hunter2. Score: 742"], expected: ["Token: [redacted]. Score: 742"] },
      { nodes: ["Password - hunter2. Score: 742"], expected: ["Password [redacted]. Score: 742"] },
    ];
    for (const label of ["PIN", "Password", "Passcode", "SSN", "Social security number", "Account number", "Routing number", "Token", "Authorization"]) {
      for (const separator of [" ", ": ", "# ", " is "]) {
        cases.push({ nodes: [`${label}${separator}correct horse battery. Score: 742. Balance: $412.`], expected: [`${label}${separator}[redacted]. Score: 742. Balance: $412.`] });
      }
      cases.push({ nodes: [label, "correct horse battery", "Score: 742"], expected: [label, "[redacted]", "Score: 742"] });
      cases.push({ nodes: [label, "Available balance: $412"], expected: [label, "Available balance: $412"] });
    }
    for (const { nodes, expected } of cases) {
      await page.setContent(`<main>${nodes.map((text) => `<p>${text}</p>`).join("")}</main>`);
      const read = await page.evaluate(readLiveRegion, { selector: "main", limit: LIVE_READ_LIMIT });
      assert.equal(read.text, expected.join("\n"), JSON.stringify(nodes));
      assert.equal(read.truncated, false);
    }
  } finally { await browser.close(); }
});

test("closing a left-open copied Chrome releases its lease before the next replay or session", { timeout: 120_000 }, async (t) => {
  const dirs = applyHermeticApp("live-read-copy-close");
  const sourceRoot = path.join(dirs.home, "source");
  mkdirSync(path.join(sourceRoot, "Default"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic profile" } } } }));
  const launcher = require("../../src/launch") as typeof import("../../src/launch");
  const realLaunch = launcher.launchOwnedChrome;
  const contexts: Awaited<ReturnType<typeof launchOwnedChrome>>[] = [];
  t.mock.method(launcher, "launchOwnedChrome", async (options: Parameters<typeof launchOwnedChrome>[0]) => {
    const context = await realLaunch({ ...options, headless: true, childHome: dirs.nativeHostHome });
    contexts.push(context);
    return context;
  });
  const server = createServer((_req, res) => res.end("<title>Report</title><main>Freeze status: Frozen. Score: 742.</main>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const copies: Awaited<ReturnType<typeof openCopiedChrome>>[] = [];
  let released = 0;
  const host = createLiveHost({ home: dirs.home, lockFile: path.join(dirs.home, "copy.lock"), selectRun: async () => {
    const copy = await openCopiedChrome({ sourceRoot, home: dirs.home, directory: "Default" });
    copies.push(copy);
    return { ...copy, engineName: "old", close: async () => { await copy.close(); released += 1; } };
  } });
  const extract = liveReadSpec("report", "main");
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 3, id: "wf-copy-read", name: "Report", driver: "cdp-live", startUrl: url, createdAt: 1, inputs: [],
    outputs: [{ name: "report", type: "table", from: "report", columns: [{ name: "text", type: "text" }] }],
    steps: [{ id: "read", index: 0, action: "extract", label: "Read report", surface: "dom", timeoutMs: 5000, heal: "never", locators: extract.locators, extract }],
  };
  assert.deepEqual(validateWorkflow(workflow), []);
  try {
    for (const next of ["replay", "session"] as const) {
      const kept = await host.replay(workflow, {}, { leaveOpen: true });
      assert.equal(kept.status, "passed");
      assert.equal(kept.pageLeftOpen, true);
      const copy = copies.at(-1)!;
      const profileDir = path.dirname(copy.target.portFile);
      assert.equal(existsSync(profileDir), true);
      if (next === "replay") {
        const cdp = await contexts.at(-1)!.browser()!.newBrowserCDPSession();
        await cdp.send("Browser.close").catch(() => undefined);
      } else {
        const pids = pidsForDataDir(profileDir);
        assert.ok(pids.length > 0);
        for (const pid of pids) process.kill(pid, "SIGTERM");
      }
      await copy.closed;
      if (next === "replay") {
        const run = await host.replay(workflow);
        assert.equal(run.status, "passed", run.failure?.reason);
      } else {
        const started = await host.call({ op: "live_session_start", intent: "Read report", url, workflowId: "wf-after-copy-close" }) as { outcome: { kind: string } };
        assert.equal(started.outcome.kind, "applied");
        await host.call({ op: "live_read", name: "report", selector: "main" });
        const stopped = await host.call({ op: "live_stop" }) as { outcome: { kind: string } };
        assert.equal(stopped.outcome.kind, "stopped");
      }
      assert.equal(existsSync(profileDir), false);
      assert.notEqual(copies.at(-1)!.target.portFile, copy.target.portFile);
    }
    assert.equal(released, 4);
  } finally {
    await host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(released, 4);
});
