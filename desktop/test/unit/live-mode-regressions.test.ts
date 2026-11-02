import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { adoptLiveWindow, CdpLiveDriver, openLiveWindow, type LiveNavigationOptions } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { readLivePage, type PageFacts } from "../../src/cdp-live/live-ops";
import { LIVE_READ_LIMIT, liveReadSpec, readLiveRegion } from "../../src/cdp-live/live-read";
import { GuardedLiveDriver, liveScope, type LiveWindow } from "../../src/cdp-live/live-replay";
import { openProfileWindow } from "../../src/cdp-live/live-target";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome } from "../../src/launch";
import type { Identity } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { applyHermeticApp, laneChildEnv } from "../runtime";

test("every owned-window entry applies navigation policy before startup events", async () => {
  for (const entry of ["adopt", "open", "profile"] as const) {
    for (const scenario of [
      { url: "https://other.example/page", policy: { careful: false, origins: ["https://start.example"], stopPath: "" }, reason: "" },
      { url: "https://start.example/page", policy: { careful: true, origins: ["https://start.example"], stopPath: "/stop" }, reason: "" },
      { url: "https://start.example:8443/page", policy: { careful: true, origins: ["https://start.example"], stopPath: "" }, reason: "start.example" },
      { url: "https://start.example/stop", policy: { careful: true, origins: ["https://start.example"], stopPath: "/stop" }, reason: "stop-path" },
      { url: "https://other.example/page", policy: {}, reason: "other.example" },
    ] satisfies { url: string; policy: LiveNavigationOptions; reason: string }[]) {
      const sent: string[] = [];
      const handlers = new Map<string, (params: Record<string, unknown>) => void>();
      const emit = (method: string, params: Record<string, unknown>) => handlers.get(method)?.(params);
      const cdp = {
        on: (method: string, _session: string | undefined, handler: (params: Record<string, unknown>) => void) => handlers.set(method, handler),
        send: async (method: string) => {
          sent.push(method);
          if (method === "Target.createTarget") return { targetId: "owned" };
          if (method === "Target.attachToTarget") return { sessionId: "session" };
          if (method === "Fetch.enable") {
            emit("Fetch.requestPaused", { requestId: "document", frameId: "owned", request: { url: scenario.url } });
            if (scenario.reason !== "stop-path") emit("Page.frameNavigated", { frame: { url: scenario.url } });
          }
          if (method === "Runtime.evaluate") return { result: { value: null } };
          return {};
        },
      } as unknown as CdpSocket;
      const hosts = ["start.example"];
      const driver = entry === "profile"
        ? await openProfileWindow(cdp, hosts, { pid: 1, userDataDir: "/synthetic", profile: "Default" }, async (ask) => {
          emit("Target.targetCreated", { targetInfo: { type: "page", targetId: "owned", url: ask.url } });
        }, 1000, scenario.policy)
        : entry === "open"
          ? await openLiveWindow(cdp, hosts, scenario.policy)
          : await adoptLiveWindow(cdp, hosts, "owned", scenario.policy);
      const context = `${entry}: ${scenario.url}`;
      assert.equal(driver.takeBlockedNav(), scenario.reason, context);
      assert.equal(sent.includes("Fetch.failRequest"), !!scenario.reason, context);
      assert.equal(sent.includes("Fetch.continueRequest"), !scenario.reason, context);
      assert.equal(sent.includes("Target.closeTarget"), !!scenario.reason && scenario.reason !== "stop-path", context);
    }
  }
});

test("guarded replay supplies page context for both actions and extracts", async () => {
  const auth = "https://console.cloud.google.com/auth/overview";
  for (const scenario of [
    { url: auth, blocked: "", password: false, text: "Sign in with Google. Single sign-on.", halt: false },
    { url: "https://console.cloud.google.com/auth/branding", blocked: "", password: false, text: "Sign in with Google.", halt: false },
    { url: "https://other.example/auth/overview", blocked: "", password: false, text: "Sign in with Google.", halt: true },
    { url: "https://console.cloud.google.com/other", blocked: "", password: false, text: "Sign in with Google.", halt: true },
    { url: auth, blocked: "login", password: false, text: "Sign in with Google.", halt: true },
    { url: auth, blocked: "", password: true, text: "Sign in with Google.", halt: true },
    { url: auth, blocked: "", password: false, text: "Verification code", halt: true },
  ]) {
    for (const action of ["click", "read"] as const) {
      const effects: string[] = [];
      const facts: PageFacts = {
        url: scenario.url, path: new URL(scenario.url).pathname, title: "Auth Platform", headings: [], blocked: scenario.blocked, text: scenario.text, marked: 0,
        controls: [{ index: 0, label: "Get started", kind: "button" }, ...(scenario.password ? [{ index: 1, label: "Password", kind: "field", field: { type: "password", name: "password", autocomplete: "" } }] : [])],
      };
      const inner = {
        handleOf: () => "handle",
        evaluateFunction: async (fn: unknown) => {
          if (fn === readLivePage) return facts;
          assert.equal(fn, readLiveRegion);
          effects.push("read");
          return { text: "Status: ready", truncated: false };
        },
        markTrust: () => undefined,
        takeBlockedNav: () => "",
        clickCss: async () => { effects.push("click"); },
      } as unknown as LiveWindow;
      const guarded = new GuardedLiveDriver(inner, liveScope(scenario.url));
      const run = () => action === "click"
        ? guarded.click({ surface: "dom", role: "button", name: "Get started", path: [] })
        : guarded.readList(liveReadSpec("status"));
      if (scenario.halt) {
        await assert.rejects(run, /login_wall/);
        assert.deepEqual(effects, []);
      } else {
        await run();
        assert.deepEqual(effects, [action]);
        assert.equal(guarded.stopped, undefined);
      }
    }
  }
});

test("CDP select-all commands use only the platform modifier and keep other chords intact", async () => {
  const sent: Record<string, unknown>[] = [];
  const cdp = { send: async (_method: string, params: Record<string, unknown>) => { sent.push(params); return {}; } } as unknown as CdpSocket;
  const driver = new CdpLiveDriver(cdp, "session", "owned");
  for (const chord of ["Meta+a", "Cmd+A", "Control+a", "Ctrl+A", "Meta+Shift+a", "Control+Shift+a", "Alt+a", "Meta+Control+a", "Meta+Alt+a", "Control+Alt+a", "Meta+b", "Control+b", "a", "Shift+a"]) {
    sent.length = 0;
    await driver.key(chord);
    const selectAll = process.platform === "darwin" ? /^(Meta|Cmd)\+a$/i : /^(Control|Ctrl)\+a$/i;
    assert.deepEqual(sent[0]?.commands ?? [], selectAll.test(chord) ? ["selectAll"] : [], chord);
    assert.equal(sent[1]?.commands, undefined, chord);
    assert.equal(sent[0]?.text, chord === "a" ? "a" : chord === "Shift+a" ? "A" : "", chord);
  }
});

interface Reply {
  session: string;
  outcome: { kind: string; reason?: string };
  view: { controls: { ref: string; label: string; options?: { value: string; selected: boolean; disabled: boolean }[] }[] };
  tabs?: { tab: string; active: boolean; url: string }[];
  read?: { text: string };
}

function ref(reply: Reply, label: string): string {
  const found = reply.view.controls.find((control) => control.label === label);
  assert.ok(found, `${label}: ${JSON.stringify(reply)}`);
  return found.ref;
}

const secretLabels = ["API key", "Client secret", "CVV", "CVC", "Security code", "Verification code", "One-time code", "OTP"];

describe("live session behavioral regressions", { timeout: 120_000 }, () => {
  const dirs = applyHermeticApp("live-mode-regressions");
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>>;
  let url: string;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/popup") return res.end("<title>Popup</title><button>Finish</button>");
    if (req.url === "/editing") return res.end(`<title>Editing</title><style>[contenteditable]{min-height:24px}</style>
      <main oninput="document.querySelector('#value').textContent='Value:'+(event.target.isContentEditable ? event.target.textContent : event.target.value)">
      <label>Name<input></label><label>Note<textarea></textarea></label><div contenteditable aria-label="Editor"></div></main><p id="value">Value:</p>`);
    if (req.url === "/secrets") return res.end(`<title>Details</title>${secretLabels.map((label, index) => `<section id="secret-${index}" name="${label}" aria-label="${label}"><p>${label}: private-inline-${index}. Status: ready.</p><p>${label}</p><p>private-split-${index}</p><p>Balance: $412</p></section><button>${label}</button>`).join("")}`);
    res.end(`<title>Controls</title><label>Note<textarea></textarea></label>
      <label>Audience<select id="audience" onclick="document.body.dataset.clicked='yes'" oninput="document.body.dataset.inputs=String(Number(document.body.dataset.inputs||0)+1)" onchange="document.querySelector('#result').textContent='Audience: '+this.selectedOptions[0].label">
      <option value="internal">Internal</option><option value="external">External</option><option value="one">Duplicate</option><option value="two">Duplicate</option><option value="repeated">First</option><option value="repeated">Second</option><option disabled value="disabled">Disabled</option><optgroup disabled label="Unavailable"><option value="grouped">Grouped</option></optgroup></select></label>
      <label>Disabled audience<select disabled><option value="unavailable">Unavailable</option></select></label>
      <fieldset disabled><label>Disabled fieldset<select><option value="nested">Nested</option></select></label></fieldset>
      <p id="result">Audience: Internal</p><form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Created'"><button>Create</button></form>
      <a href="/popup" target="_blank">New tab</a>`);
  });
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  });
  after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const newHost = (name: string) => createLiveHost({ home: path.join(dirs.home, name), lockFile: path.join(dirs.home, `${name}.lock`), target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") }, idleMs: 0 });

  test("invalid selections recover, never click, and recorded selections replay guarded", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const host = newHost("select");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      for (const careful of [false, true]) {
        let reply = await call({ op: "live_session_start", careful, intent: `Choose audience ${careful}`, url });
        assert.equal(reply.outcome.kind, "applied");
        const options = (label: string) => reply.view.controls.find((control) => control.label === label)!.options!;
        assert.deepEqual(options("Audience").map((option) => [option.value, option.disabled]), [["internal", false], ["external", false], ["one", false], ["two", false], ["repeated", false], ["repeated", false], ["disabled", true], ["grouped", true]]);
        for (const [label, value] of [["Disabled audience", "unavailable"], ["Disabled fieldset", "nested"]]) {
          assert.equal(options(label)[0]?.disabled, true, label);
          assert.deepEqual((await call({ op: "live_select", ref: ref(reply, label), option: value })).outcome, { kind: "refused", reason: "option is disabled" });
        }
        await live!.evaluateFunction(() => {
          const cover = document.createElement("div");
          cover.id = "cover";
          cover.style.cssText = "position:fixed;inset:0;background:white;z-index:9999";
          document.body.append(cover);
        }, null);
        assert.deepEqual((await call({ op: "live_select", ref: ref(reply, "Audience"), option: "external" })).outcome, { kind: "refused", reason: "element is covered" });
        await live!.evaluateFunction(() => document.querySelector("#cover")?.remove(), null);
        for (const [option, reason] of [["absent", "option not found"], ["Duplicate", "ambiguous option"], ["repeated", "ambiguous option"], ["disabled", "option is disabled"], ["grouped", "option is disabled"]]) {
          const result = await call({ op: "live_select", ref: ref(reply, "Audience"), option });
          assert.deepEqual(result.outcome, { kind: "refused", reason });
        }
        assert.deepEqual(await live!.evaluateFunction(() => ({ value: (document.querySelector("select") as HTMLSelectElement).value, inputs: document.body.dataset.inputs || "0", clicked: document.body.dataset.clicked || "no" }), null), { value: "internal", inputs: "0", clicked: "no" });
        await live!.evaluateFunction(() => {
          document.querySelector("optgroup")!.disabled = false;
          document.querySelector<HTMLSelectElement>("select[disabled]")!.disabled = false;
          document.querySelector("fieldset")!.disabled = false;
        }, null);
        reply = await call({ op: "live_snapshot" });
        assert.equal(options("Audience").find((option) => option.value === "grouped")?.disabled, false);
        assert.equal(options("Audience").find((option) => option.value === "disabled")?.disabled, true);
        assert.equal(options("Disabled audience")[0]?.disabled, false);
        assert.equal(options("Disabled fieldset")[0]?.disabled, false);
        reply = await call({ op: "live_select", ref: ref(reply, "Audience"), option: careful ? "external" : "External" });
        assert.equal(reply.outcome.kind, "applied");
        assert.deepEqual(await live!.evaluateFunction(() => ({ value: (document.querySelector("select") as HTMLSelectElement).value, inputs: document.body.dataset.inputs, clicked: document.body.dataset.clicked || "no" }), null), { value: "external", inputs: "1", clicked: "no" });
        const read = await call({ op: "live_read", name: "audience", selector: "#result" });
        assert.equal(read.read?.text, "Audience: External");
        await call({ op: "live_stop" });
        const home = path.join(dirs.home, "select");
        assert.equal(JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")).status, "passed");
        const workflow = new Library(home).read(reply.session);
        assert.deepEqual(workflow.steps.map((step) => step.action), ["select", "extract"]);
        const replay = await host.replay(workflow);
        assert.equal(replay.status, "passed", JSON.stringify(replay.failure));
        assert.equal(replay.modelCalls, 0);
        const output = replay.outputs?.[0];
        assert.equal(output?.type, "table");
        assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, "Audience: External");
        const select = workflow.steps[0]!;
        const denied = { ...workflow, steps: [{ ...select, identity: { ...select.identity, name: "Create", role: "button" } as Identity, locators: [{ kind: "role" as const, role: "button", name: "Create" }] }] };
        const blocked = await host.replay(denied);
        assert.equal(blocked.status, "failed");
        assert.equal(blocked.failure?.reason, "stop_before_confirm");
      }
      let reply = await call({ op: "live_session_start", intent: "Recover and create", url });
      assert.equal((await call({ op: "live_select", ref: ref(reply, "Audience"), option: "absent" })).outcome.kind, "refused");
      reply = await call({ op: "live_click", ref: ref(reply, "Create") });
      assert.equal(reply.outcome.kind, "applied");
      await call({ op: "live_stop" });
      assert.equal(JSON.parse(readFileSync(path.join(dirs.home, "select", "live-session", "session.json"), "utf8")).status, "passed");
    } finally { await host.close(); }
  });

  test("Shift inserts shifted characters while shortcuts insert no text", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const host = newHost("shift");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      let reply = await call({ op: "live_session_start", intent: "Type shifted text", url });
      for (const key of ["a", "Shift+a", "Shift+2", "Space", "Shift+z"]) {
        reply = await call({ op: "live_key", ref: ref(reply, "Note"), key });
        assert.equal(reply.outcome.kind, "applied", key);
      }
      const value = () => live!.evaluateFunction<string>(() => (document.querySelector("textarea") as HTMLTextAreaElement).value, null);
      assert.equal(await value(), "aA@ Z");
      await live!.key("Shift+/");
      assert.equal(await value(), "aA@ Z?");
      for (const key of ["Control+Shift+a", "Meta+Shift+a", "Alt+Shift+a"]) {
        reply = await call({ op: "live_key", ref: ref(reply, "Note"), key });
        assert.equal(reply.outcome.kind, "applied");
        assert.equal(await value(), "aA@ Z?");
      }
      await call({ op: "live_stop" });
    } finally { await host.close(); }
  });

  test("MCP select-all deletes and replaces input, textarea, and editable text", async () => {
    const home = path.join(dirs.home, "editing");
    const app = await startApp({ home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(home, "lock") });
    const pinned = process.env.BAO_TEST_BROWSER;
    const mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned ?? chromium.executablePath()), HOME: dirs.nativeHostHome, BAO_HOME: home });
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
      const result = await mcp.call(name, args);
      assert.equal(result.isError, false, result.text);
      const reply = JSON.parse(result.text) as Reply;
      if (name !== "live_stop") assert.equal(reply.outcome.kind, "applied", result.text);
      return reply;
    };
    try {
      await mcp.handshake();
      let reply = await call("live_session_start", { intent: "Edit local fields", url: url + "/editing" });
      const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
      const alias = process.platform === "darwin" ? "Cmd+A" : "Ctrl+A";
      for (const [index, label] of ["Name", "Note", "Editor"].entries()) {
        reply = await call("live_type", { ref: ref(reply, label), text: "abcdef" });
        reply = await call("live_key", { ref: ref(reply, label), key: selectAll });
        reply = await call("live_key", { ref: ref(reply, label), key: "Backspace" });
        reply = await call("live_read", { name: `deleted_${index}`, selector: "#value" });
        assert.equal(reply.read?.text, "Value:", label);
        reply = await call("live_type", { ref: ref(reply, label), text: "abcdef" });
        reply = await call("live_key", { ref: ref(reply, label), key: alias });
        reply = await call("live_type", { ref: ref(reply, label), text: "replacement" });
        reply = await call("live_read", { name: `replaced_${index}`, selector: "#value" });
        assert.equal(reply.read?.text, "Value:replacement", label);
      }
      await call("live_stop");
    } finally {
      await mcp.close();
      await app.close();
    }
  });

  test("YOLO reads secret-named regions but redacts only their secret values", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const host = newHost("read");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      const reply = await call({ op: "live_session_start", intent: "Read local details", url: url + "/secrets" });
      for (const [index, label] of secretLabels.entries()) {
        assert.ok(ref(reply, label));
        const read = await call({ op: "live_read", name: `detail_${index}`, selector: `#secret-${index}` });
        assert.equal(read.outcome.kind, "applied");
        assert.equal(read.read?.text, `${label}: [redacted]. Status: ready.\n${label}\n[redacted]\nBalance: $412`);
        await assert.rejects(live!.evaluateFunction(readLiveRegion, { selector: `#secret-${index}`, limit: LIVE_READ_LIMIT, careful: true }), /hidden or sensitive/);
      }
      await call({ op: "live_stop" });
      const trail = readFileSync(path.join(dirs.home, "read", "live-session", "trail.jsonl"), "utf8");
      assert.doesNotMatch(trail, /private-inline|private-split/);
    } finally { await host.close(); }
  });

  test("switching an owned popup allows a cross-host navigation during adoption", async (t) => {
    let navigateDuringStart = false;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) {
      await start.call(this);
      if (navigateDuringStart) {
        const popup = browser.pages().find((page) => page.url() === url + "/popup");
        assert.ok(popup);
        await popup.goto(url.replace("127.0.0.1", "localhost") + "/popup");
      }
    });
    const host = newHost("adopt");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      let reply = await call({ op: "live_session_start", intent: "Switch popup", url });
      const parent = (await call({ op: "live_tabs" })).tabs![0]!.tab;
      reply = await call({ op: "live_click", ref: ref(reply, "New tab") });
      assert.equal(reply.outcome.kind, "applied");
      const popup = (await call({ op: "live_tabs" })).tabs!.find((tab) => tab.tab !== parent)!;
      assert.ok(popup);
      navigateDuringStart = true;
      reply = await call({ op: "live_switch_tab", tab: popup.tab });
      navigateDuringStart = false;
      assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      assert.ok(ref(reply, "Finish"));
      assert.equal((await call({ op: "live_tabs" })).tabs!.find((tab) => tab.active)?.url, url.replace("127.0.0.1", "localhost") + "/popup");
      assert.equal((await call({ op: "live_switch_tab", tab: parent })).outcome.kind, "applied");
      await call({ op: "live_stop" });
    } finally { await host.close(); }
  });
});
