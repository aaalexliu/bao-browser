import assert from "node:assert/strict";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { startApp } from "../../src/app/server";
import { McpClient } from "../../src/eval/mcp-client";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { readLivePage, type PageFacts } from "../../src/cdp-live/live-ops";
import { launchOwnedChrome, pinTestBrowser } from "../../src/launch";
import { liveCliBody } from "../../src/mcp/live-proxy";
import { Library } from "../../src/v1/store";
import { applyHermeticApp, laneChildEnv } from "../runtime";

type Reply = {
  session: string;
  shot: string;
  shotPath?: string;
  toolCallId?: string;
  outcome: { kind: string; reason?: string; blocker?: { text: string; role: string; region: { x: number; y: number; width: number; height: number }; dismissRef?: string } };
  readiness?: { state: string };
  view: { path: string; headings: string[]; controls: { ref: string; label: string; kind: string; value?: string }[] };
};
const ref = (reply: Reply, label: string) => {
  assert.ok(reply.view, JSON.stringify(reply));
  const found = reply.view.controls.find((item) => item.label === label);
  assert.ok(found, `${label}: ${JSON.stringify(reply)}`);
  return found.ref;
};

test("CLI forwards explicit replacement without changing insertion defaults", () => {
  assert.deepEqual(liveCliBody("live_type", ["--ref", "e1.c0", "--text", "new", "--replace"]), { op: "live_type", ref: "e1.c0", text: "new", replace: true });
  assert.equal(liveCliBody("live_type", ["--ref", "e1.c0", "--text", "new"]).replace, undefined);
});

const nativeBinary = process.env.AGENT_BROWSER_PARITY_BINARY || process.env.BAO_AGENT_BROWSER;
for (const engineName of ["old", "agent-browser"] as const) describe(`OAuth run regressions: ${engineName}`, { timeout: 120_000, skip: engineName === "agent-browser" && !nativeBinary }, () => {
  const dirs = applyHermeticApp(`oauth-${engineName}`);
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>>;
  let url = "";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/new") return res.end('<title>New project</title><form action="/confirm"><button>Create</button></form>');
    if (pathname === "/confirm") return res.end('<title>Confirm project</title><form action="/done"><button>Confirm</button></form>');
    if (pathname === "/done") return res.end('<title>Done</title><h1>Done</h1>');
    if (req.url === "/route") return res.end(`<title>Routing</title><main><h1>Old panel</h1><p>Creation form</p><button onclick="history.pushState({},'', '/next');document.title='Clients';document.querySelector('h1').textContent='Clients';this.textContent='Loading';setTimeout(()=>document.querySelector('main').innerHTML='<h1>New panel</h1><p>Client list</p><button>Ready</button>',450)">Open panel</button></main>`);
    if (req.url === "/pending") return res.end(`<title>Routing</title><main><h1>Old panel</h1><p>Creation form</p><button onclick="history.pushState({},'', '/pending-next');document.title='Clients';document.querySelector('h1').textContent='Clients';this.textContent='Loading'">Open panel</button></main>`);
    if (req.url === "/slow-empty") return res.end(`<title>Routing</title><main><p>Creation form</p></main><button onclick="history.pushState({},'', '/slow-empty-next');document.querySelector('main').innerHTML='<h1>Blank panel</h1>'">Open panel</button>`);
    if (req.url === "/empty") return res.end(`<title>Routing</title><nav>Old breadcrumb</nav><main></main><button onclick="history.pushState({},'', '/empty-next');document.title='Clients';document.querySelector('nav').textContent='Clients'">Open panel</button>`);
    if (req.url === "/cover") return res.end(`<title>Covered Save</title><style>#save,select{position:fixed;top:100px;left:100px;width:140px;height:40px}select{top:180px}.notice{position:fixed;left:90px;top:90px;width:300px;height:150px;background:white;z-index:100}</style><button id="save" onclick="document.body.dataset.saved='yes'">Save</button><select aria-label="Audience"><option>Internal</option><option>External</option></select><div class="notice" role="status">Branding changes saved!<button aria-label="Dismiss notice" onclick="this.parentElement.remove()">Close</button></div>`);
    res.end(`<title>OAuth local form</title><style>label{display:block;margin:20px}[contenteditable]{min-height:24px}</style><main><h1>App details</h1><label>App name<input value="五秒"></label><label>Note<textarea aria-label="Note">old note</textarea></label><div contenteditable aria-label="Editor">old text</div><label>Client secret<input value="private-oauth-value"></label><label>Note key<input value="sk-fixture_secret_12345678901234567890"></label><label>Password<input type="password" value="private-password"></label></main>`);
  });
  before(async () => {
    pinTestBrowser();
    if (engineName === "agent-browser") process.env.BAO_AGENT_BROWSER = nativeBinary;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  });
  after(async () => { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  function hostFor(name: string) {
    const home = path.join(dirs.home, name);
    const target = { kind: "throwaway" as const, portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") };
    const host = createLiveHost({ home, target, lockFile: path.join(dirs.home, `${name}.lock`), selectRun: async () => ({ target, engineName }), idleMs: 0 });
    return { host, home, call: (body: Record<string, unknown>) => host.call(body) as Promise<Reply> };
  }
  const page = () => browser.pages().filter((item) => item.url().startsWith(url)).at(-1)!;
  async function proof(reply: Reply, name: string) {
    const root = process.env.BAO_OAUTH_PROOF;
    if (!root || !reply.shot) return;
    await mkdir(root, { recursive: true });
    await copyFile(path.join(dirs.home, name, "live-session", "shots", reply.shot), path.join(root, `${engineName}-${name}.png`));
  }

  test("replace and empty clear work for every editable kind, while insert stays insert", async () => {
    const { host, call, home } = hostFor("replace");
    try {
      let reply = await call({ op: "live_session_start", intent: "Edit app details", url });
      await proof(reply, "replace");
      for (const label of ["App name", "Note", "Editor"]) {
        reply = await call({ op: "live_type", ref: ref(reply, label), text: "Chinglish AI", replace: true });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
        assert.equal(await page().getByLabel(label, { exact: true }).evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent), "Chinglish AI", label);
        reply = await call({ op: "live_type", ref: ref(reply, label), text: "+" });
        assert.equal(reply.view.controls.find((item) => item.label === label)?.value, "Chinglish AI+");
        reply = await call({ op: "live_type", ref: ref(reply, label), text: "", replace: true });
        assert.equal(reply.outcome.kind, "applied", `${label}: ${JSON.stringify(reply)}`);
        assert.equal(reply.view.controls.find((item) => item.label === label)?.value, "");
        assert.equal(await page().getByLabel(label, { exact: true }).evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent), "");
        reply = await call({ op: "live_type", ref: ref(reply, label), text: "final", replace: true });
        assert.equal(reply.outcome.kind, "applied", `${label}: ${JSON.stringify(reply)}`);
      }
      await proof(reply, "replace");
      await call({ op: "live_stop" });
      const workflow = new Library(home).read(reply.session);
      assert.deepEqual(workflow.inputs.map((input) => input.default), ["final", "final", "final"]);
      const trail = (await readFile(path.join(home, "live-session", "trail.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(trail.filter((event) => event.op === "type").map((event) => event.value), Array(3).fill(["Chinglish AI", "Chinglish AI+", "", "final"]).flat());
    } finally { await host.close(); }
  });

  if (engineName === "old") test("MCP exposes and forwards replacement and returns an openable screenshot path", async () => {
    const home = path.join(dirs.home, "mcp");
    const app = await startApp({ home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(dirs.home, "mcp.lock") });
    const pinned = process.env.BAO_TEST_BROWSER!;
    const mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned), HOME: dirs.nativeHostHome, BAO_HOME: home });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcp.call(name, args);
      assert.equal(result.isError, false, result.text);
      return JSON.parse(result.text) as Reply;
    };
    try {
      await mcp.handshake();
      const listed = await mcp.request("tools/list", {}) as { tools?: { name: string; inputSchema?: { properties: Record<string, unknown> } }[] };
      assert.deepEqual(listed.tools?.find((tool) => tool.name === "live_type")?.inputSchema?.properties.replace, { type: "boolean" });
      let reply = await call("live_session_start", { intent: "Replace through MCP", url });
      reply = await call("live_type", { ref: ref(reply, "App name"), text: "Chinglish AI", replace: true });
      assert.equal(reply.view.controls.find((item) => item.label === "App name")?.value, "Chinglish AI");
      reply = await call("live_type", { ref: ref(reply, "App name"), text: "", replace: true });
      assert.equal(reply.view.controls.find((item) => item.label === "App name")?.value, "");
      reply = await call("live_screenshot");
      assert.equal((await readFile(reply.shotPath!)).subarray(1, 4).toString(), "PNG");
      await call("live_stop");
    } finally { await mcp.close(); await app.close(); }
  });

  test("snapshots show safe values but not credential labels or secret-shaped values", async () => {
    const { host, call } = hostFor("values");
    try {
      const reply = await call({ op: "live_session_start", intent: "Read app details", url });
      assert.equal(reply.view.controls.find((item) => item.label === "App name")?.value, "五秒");
      for (const label of ["Client secret", "Note key", "Password"]) assert.equal(reply.view.controls.find((item) => item.label === label)?.value, undefined, label);
      assert.doesNotMatch(JSON.stringify(reply), /private-oauth-value|sk-fixture|private-password/);
    } finally { await host.close(); }
  });

  test("platform select-all changes the selection and Backspace clears all editable kinds", async () => {
    const { host, call } = hostFor("keys");
    try {
      let reply = await call({ op: "live_session_start", intent: "Select app details", url });
      for (const label of ["App name", "Note", "Editor"]) {
        reply = await call({ op: "live_key", ref: ref(reply, label), key: process.platform === "darwin" ? "Meta+a" : "Control+a" });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
        const length = await page().getByLabel(label, { exact: true }).evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.selectionEnd || 0) - (el.selectionStart || 0) : window.getSelection()?.toString().length || 0);
        assert.ok(length > 1, `${label}: full selection`);
        reply = await call({ op: "live_key", ref: ref(reply, label), key: "Backspace" });
        assert.equal(await page().getByLabel(label, { exact: true }).evaluate((el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent), "", label);
      }
    } finally { await host.close(); }
  });

  test("covered clicks and selects name the blocker and offer a hit-tested dismissal", async (t) => {
    let injectOnDismiss = false;
    const evaluate = CdpLiveDriver.prototype.evaluateFunction;
    t.mock.method(CdpLiveDriver.prototype, "evaluateFunction", async function (this: CdpLiveDriver, ...args: Parameters<CdpLiveDriver["evaluateFunction"]>) {
      const result = await evaluate.apply(this, args);
      if (injectOnDismiss && args[0] === readLivePage && (args[1] as { markHandle?: string })?.markHandle) {
        const facts = result as PageFacts;
        if (facts.controls.find((control) => control.index === facts.marked)?.label === "Dismiss notice") {
          injectOnDismiss = false;
          await evaluate.call(this, () => { const decoy = document.createElement("button"); decoy.textContent = "Unrelated control"; document.body.prepend(decoy); }, null);
        }
      }
      return result;
    });
    const { host, call } = hostFor("coverage");
    try {
      let reply = await call({ op: "live_session_start", intent: "Save local branding", url: url + "/cover" });
      for (const [op, label] of [["live_click", "Save"], ["live_select", "Audience"]]) {
        injectOnDismiss = true;
        reply = await call({ op, ref: ref(reply, label!), option: "External" });
        assert.equal(reply.outcome.reason, "element is covered");
        assert.match(reply.outcome.blocker?.text || "", /Branding changes saved/);
        assert.equal(reply.outcome.blocker?.role, "status");
        assert.ok(reply.outcome.blocker?.region.width);
        assert.ok(reply.outcome.blocker?.dismissRef);
        assert.equal(reply.view.controls.find((control) => control.ref === reply.outcome.blocker?.dismissRef)?.label, "Dismiss notice", "dismiss ref belongs to the returned epoch after a control is inserted");
        assert.equal(await page().evaluate(() => document.body.dataset.saved || "no"), "no");
      }
      reply = await call({ op: "live_click", ref: reply.outcome.blocker!.dismissRef });
      reply = await call({ op: "live_click", ref: ref(reply, "Save") });
      assert.equal(reply.outcome.kind, "applied");
      assert.equal(await page().evaluate(() => document.body.dataset.saved), "yes");
      for (const variant of ["disabled", "duplicate", "covered"]) {
        await page().evaluate((variant) => {
          document.querySelector(".notice")?.remove();
          delete document.body.dataset.saved;
          const notice = document.createElement("div");
          notice.className = "notice";
          notice.setAttribute("role", "status");
          notice.innerHTML = `Blocked notice<button aria-label="Close notice" ${variant === "disabled" ? "disabled" : ""}>Close</button>${variant === "duplicate" ? '<button aria-label="Dismiss notice">Dismiss</button>' : ""}`;
          document.body.append(notice);
          if (variant === "covered") {
            const cover = document.createElement("div");
            const r = notice.querySelector("button")!.getBoundingClientRect();
            cover.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:white;z-index:101`;
            notice.append(cover);
          }
        }, variant);
        reply = await call({ op: "live_snapshot" });
        for (const [op, label] of [["live_click", "Save"], ["live_select", "Audience"]]) {
          reply = await call({ op, ref: ref(reply, label!), option: "External" });
          assert.equal(reply.outcome.reason, "element is covered");
          assert.equal(reply.outcome.blocker?.dismissRef, undefined, variant);
          assert.equal(await page().evaluate(() => document.body.dataset.saved), undefined);
        }
      }
    } finally { await host.close(); }
  });

  test("blocker diagnosis preserves notice words and offers only exact dismiss names", async () => {
    const { host, call } = hostFor("blocker-table");
    try {
      let reply = await call({ op: "live_session_start", intent: "Inspect covered actions", url: url + "/cover" });
      for (const [name, allowed] of [
        ["Close", true], ["Dismiss", true], ["Close notification", true], ["Close dialog", true],
        ["Dismiss notice", true], ["x", true], ["×", true], ["OK", false], ["Got it", false],
        ["Continue", false], ["Confirm", false], ["Close account", false], ["Dismiss all changes", false],
      ] as const) {
        await page().evaluate((name) => {
          const notice = document.querySelector(".notice")!;
          notice.replaceChildren(document.createTextNode("Authorization token secret for project 123456789012 saved. GOCSPX-private_token sk-private_key ghp_private_key gho_private_key xoxb-private_key xoxp-private_key AKIAprivate_key eyJprivate_key "));
          const button = document.createElement("button");
          button.setAttribute("aria-label", name);
          button.textContent = name;
          notice.append(button);
        }, name);
        reply = await call({ op: "live_snapshot" });
        for (const [op, label] of [["live_click", "Save"], ["live_select", "Audience"]]) {
          reply = await call({ op, ref: ref(reply, label!), option: "External" });
          assert.equal(reply.outcome.reason, "element is covered");
          const blocker = reply.outcome.blocker!;
          assert.match(blocker.text, /Authorization token secret for project 123456789012 saved/);
          assert.doesNotMatch(blocker.text, /GOCSPX-|sk-private|ghp_private|gho_private|xoxb-private|xoxp-private|AKIAprivate|eyJprivate/);
          assert.equal(!!blocker.dismissRef, allowed, `${op}: ${name}`);
          if (allowed) assert.equal(reply.view.controls.find((control) => control.ref === blocker.dismissRef)?.label, name);
          assert.equal(await page().evaluate(() => document.body.dataset.saved), undefined);
          assert.equal(await page().getByLabel("Audience").inputValue(), "Internal");
        }
      }
    } finally { await host.close(); }
  });

  test("screenshots resolve under the active nondefault home", async () => {
    const { host, call, home } = hostFor("screenshot");
    try {
      await call({ op: "live_session_start", intent: "Inspect local form", url });
      const reply = await call({ op: "live_screenshot" });
      assert.equal(reply.shotPath, path.join(home, "live-session", "shots", reply.shot));
      assert.equal((await readFile(reply.shotPath!)).subarray(1, 4).toString(), "PNG");
    } finally { await host.close(); }
  });

  test("route replies wait for the new panel or explicitly report transition", async () => {
    const { host, call, home } = hostFor("readiness");
    try {
      for (const route of ["/route", "/pending", "/empty"]) {
        let reply = await call({ op: "live_session_start", intent: "Open local panel", url: url + route });
        reply = await call({ op: "live_click", ref: ref(reply, "Open panel") });
        assert.equal(reply.outcome.kind, "applied");
        if (route === "/route") {
          assert.deepEqual(reply.view.headings, ["New panel"]);
          assert.equal(reply.readiness?.state, "ready");
        } else {
          assert.equal(reply.readiness?.state, "transitional");
          const cached = await call({ op: "live_snapshot", page: 1 });
          assert.equal(cached.readiness?.state, "transitional", "cached pages keep their read's readiness marker");
          assert.deepEqual(cached.view, reply.view);
          reply = await call({ op: "live_snapshot" });
          assert.equal(reply.readiness?.state, "transitional", "a refresh must not call the same old panel ready");
        }
        await call({ op: "live_stop" });
        const session = JSON.parse(await readFile(path.join(home, "live-session", "session.json"), "utf8"));
        const timing = session.tools.find((tool: { id: string }) => tool.id === reply.toolCallId);
        const audit = session.audit.filter((row: { action: string }) => row.action === (route === "/route" ? "click" : "snapshot")).at(-1);
        assert.ok(timing.spans.wait >= 150, JSON.stringify(timing));
        assert.ok(timing.ms >= timing.spans.wait + timing.spans.snapshot);
        assert.equal(audit.ms, timing.spans.snapshot, "view duration excludes readiness sleeps");
      }
    } finally { await host.close(); }
  });

  test("slow first empty samples start stability after completion across fresh read entry points", async (t) => {
    const evaluate = CdpLiveDriver.prototype.evaluateFunction;
    let slowFirst = false;
    let observations: { panel: string; completedAt: number }[] = [];
    t.mock.method(CdpLiveDriver.prototype, "evaluateFunction", async function (this: CdpLiveDriver, ...args: Parameters<CdpLiveDriver["evaluateFunction"]>) {
      const result = await evaluate.apply(this, args);
      if (args[0] === readLivePage && (args[1] as { markIndex?: number })?.markIndex === -1) {
        const facts = result as PageFacts;
        if (slowFirst) {
          slowFirst = false;
          assert.equal(facts.panel, "");
          await new Promise((resolve) => setTimeout(resolve, 220));
          await evaluate.call(this, () => { document.querySelector("main")!.innerHTML = "<h1>New panel</h1><p>Destination content</p>"; }, null);
        }
        if (facts.url?.endsWith("/slow-empty-next")) observations.push({ panel: facts.panel || "", completedAt: Date.now() });
      }
      return result;
    });
    const { host, call } = hostFor("slow-first-sample");
    try {
      for (const op of ["live_click", "live_snapshot", "live_screenshot"]) {
        let reply = await call({ op: "live_session_start", intent: "Observe delayed panel", url: url + "/slow-empty" });
        observations = [];
        if (op !== "live_click") await page().getByRole("button", { name: "Open panel" }).click();
        slowFirst = true;
        reply = await call({ op, ...(op === "live_click" ? { ref: ref(reply, "Open panel") } : {}) });
        assert.equal(reply.readiness?.state, "ready", op);
        assert.deepEqual(reply.view.headings, ["New panel"], op);
        assert.equal(observations[0]?.panel, "");
        const destination = observations.filter((sample) => sample.panel === "Destination content");
        assert.ok(destination.length >= 2, `${op}: ${JSON.stringify(observations)}`);
        assert.ok(destination.at(-1)!.completedAt - destination[0]!.completedAt >= 150, op);
        const cached = await call({ op: "live_snapshot", page: 1 });
        assert.equal(cached.readiness?.state, "ready");
        assert.deepEqual(cached.view, reply.view);
        await call({ op: "live_stop" });
      }
    } finally { await host.close(); }
  });

  test("saved timing covers action and screenshot cost with correlated tool calls", async (t) => {
    const capture = CdpLiveDriver.prototype.captureRedacted;
    t.mock.method(CdpLiveDriver.prototype, "captureRedacted", async function (this: CdpLiveDriver, caption: string) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return capture.call(this, caption);
    });
    const { host, call, home } = hostFor("timing");
    try {
      let started = await call({ op: "live_session_start", preset: "experian", intent: "Measure local tools", url });
      started = await call({ op: "live_type", ref: ref(started, "App name"), text: "measured", replace: true });
      const began = Date.now();
      const reply = await call({ op: "live_screenshot" });
      const elapsed = Date.now() - began;
      await call({ op: "live_stop" });
      const session = JSON.parse(await readFile(path.join(home, "live-session", "session.json"), "utf8"));
      const timing = session.tools?.find((item: { id: string }) => item.id === reply.toolCallId);
      assert.ok(timing, "saved tool correlation");
      assert.equal(timing.name, "live_screenshot");
      assert.ok(timing.ms >= 180 && timing.ms <= elapsed, JSON.stringify({ elapsed, timing }));
      assert.ok(timing.spans.image >= 180, JSON.stringify(timing));
      assert.ok(session.steps.find((item: { name: string }) => item.name === "screenshot").ms >= 180);
      assert.ok(session.tools.some((item: { name: string }) => item.name === "live_stop"));
      const trail = JSON.parse((await readFile(path.join(home, "live-session", "trail.jsonl"), "utf8")).trim());
      assert.equal(trail.toolCallId, started.toolCallId);
      const run = new Library(home).listRuns()[0]!;
      assert.deepEqual(run.toolTimings, session.tools);
      assert.ok(run.toolTimings!.find((tool) => tool.id === started.toolCallId)!.spans.action! >= 0);
    } finally { await host.close(); }
  });

  test("identical button paths on two pages save both clicks", async () => {
    const { host, call, home } = hostFor("cross-page");
    try {
      let reply = await call({ op: "live_session_start", intent: "Create a local project", url: url + "/new" });
      reply = await call({ op: "live_click", ref: ref(reply, "Create") });
      reply = await call({ op: "live_click", ref: ref(reply, "Confirm") });
      assert.equal(reply.outcome.kind, "applied");
      await call({ op: "live_stop" });
      const workflow = new Library(home).read(reply.session);
      assert.deepEqual(workflow.steps.map((step) => step.label), ['Click "Create"', 'Click "Confirm"']);
    } finally { await host.close(); }
  });
});
