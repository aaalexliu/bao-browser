import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { adoptLiveWindow, CdpLiveDriver, openLiveWindow, type LiveNavigationOptions } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { keyInsertsText } from "../../src/cdp-live/keys";
import { readLivePage, type PageFacts } from "../../src/cdp-live/live-ops";
import { LIVE_READ_LIMIT, liveReadSpec, readLiveRegion } from "../../src/cdp-live/live-read";
import { GuardedLiveDriver, liveScope, type LiveWindow } from "../../src/cdp-live/live-replay";
import { openProfileWindow } from "../../src/cdp-live/live-target";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome } from "../../src/launch";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { applyHermeticApp, laneChildEnv } from "../runtime";
import { selfSignedCert } from "../instacart/cert";

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
  for (const chord of ["Meta+a", "Cmd+A", "cMd+A", "Control+a", "Ctrl+A", "cTrL+A", "Meta+Shift+a", "Control+Shift+a", "Alt+a", "Meta+Control+a", "Meta+Alt+a", "Control+Alt+a", "Meta+b", "Control+b", "a", "Shift+a"]) {
    sent.length = 0;
    await driver.key(chord);
    const selectAll = process.platform === "darwin" ? /^(Meta|Cmd)\+a$/i : /^(Control|Ctrl)\+a$/i;
    assert.deepEqual(sent[0]?.commands ?? [], selectAll.test(chord) ? ["selectAll"] : [], chord);
    assert.equal(sent[1]?.commands, undefined, chord);
    assert.equal(sent[0]?.text, chord === "a" ? "a" : chord === "Shift+a" ? "A" : "", chord);
  }
});

test("named keys dispatch canonical CDP events and text modifiers stay distinct from shortcuts", async () => {
  const sent: Record<string, unknown>[] = [];
  const cdp = { send: async (_method: string, params: Record<string, unknown>) => { sent.push(params); return {}; } } as unknown as CdpSocket;
  const driver = new CdpLiveDriver(cdp, "session", "owned");
  for (const [key, name, code, keyCode, text] of [
    ["enter", "Enter", "Enter", 13, "\r"], ["RETURN", "Enter", "Enter", 13, "\r"], ["tab", "Tab", "Tab", 9, ""],
    ["backspace", "Backspace", "Backspace", 8, ""], ["delete", "Delete", "Delete", 46, ""],
    ["arrowdown", "ArrowDown", "ArrowDown", 40, ""], ["arrowup", "ArrowUp", "ArrowUp", 38, ""],
    ["arrowleft", "ArrowLeft", "ArrowLeft", 37, ""], ["arrowright", "ArrowRight", "ArrowRight", 39, ""],
    ["space", " ", "Space", 32, " "], ["pageup", "PageUp", "PageUp", 33, ""], ["pagedown", "PageDown", "PageDown", 34, ""],
    ["home", "Home", "Home", 36, ""], ["end", "End", "End", 35, ""], ["escape", "Escape", "Escape", 27, ""],
  ] as const) {
    sent.length = 0;
    await driver.key(key);
    assert.deepEqual(sent.map((event) => [event.type, event.key, event.code, event.windowsVirtualKeyCode]), [["keyDown", name, code, keyCode], ["keyUp", name, code, keyCode]], key);
    assert.equal(sent[0]!.text, text, key);
  }
  for (const key of ["p", "A", "sHiFt+a", "Space", "sHiFt+space", "Alt+x", "Shift+Alt+x", "Ctrl+Alt+q"]) assert.equal(keyInsertsText(key), true, key);
  for (const key of ["enter", "Tab", "Escape", "Meta+a", "Cmd+A", "Control+a", "cTrL+A", "Meta+Alt+x", "Alt+ArrowDown"]) assert.equal(keyInsertsText(key), false, key);
});

interface Reply {
  session: string;
  outcome: { kind: string; reason?: string };
  view: { controls: { ref: string; label: string; options?: { value: string; label: string; selected: boolean; disabled: boolean }[] }[] };
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
  const navigationHits: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/nav-start") return res.end(`<title>Start navigation</title><button onclick="document.querySelector('#nav-result').textContent='Wrong page';this.textContent='Opened'">Open result</button><p id="nav-result">Start page</p>`);
    if (pathname === "/nav-target") {
      navigationHits.push(req.url || "");
      return res.end(`<title>Target navigation</title><button onclick="document.querySelector('#nav-result').textContent='Right page';this.textContent='Opened'">Open result</button><p id="nav-result">Target page</p>`);
    }
    if (pathname === "/credential-keys") return res.end(`<title>Local keys</title><style>[contenteditable]{min-height:24px}</style><label>Secret<input type="password"></label><input aria-label="Verification code"><label>Challenge<textarea autocomplete="one-time-code"></textarea></label><span id="security">Security code</span><div contenteditable aria-labelledby="security"></div><input placeholder="OTP"><div contenteditable autocomplete="cc-exp" aria-label="Expiry"></div><label>Note<textarea></textarea></label>`);
    if (pathname === "/collision" || pathname === "/collision-multiple") return res.end(`<title>Option collisions</title><label>Audience<select${pathname.endsWith("multiple") ? " multiple" : ""} oninput="document.body.dataset.inputs=String(Number(document.body.dataset.inputs||0)+1)" onchange="document.querySelector('#result').textContent='Audience: '+this.selectedOptions[0].label"><option selected value="initial">Initial</option><option value="Second">First</option><option value="repeated">Second</option><option value="repeated">Third</option><option value="Same">Same</option></select></label><p id="result">Audience: Initial</p>`);
    if (pathname === "/credentials") return res.end(`<title>Local form</title><label>Secret<input type="password"></label><label>Verification code<input></label><label>Challenge<input autocomplete="one-time-code"></label><label>Note<textarea></textarea></label>`);
    if (req.url === "/popup") return res.end("<title>Popup</title><button>Finish</button>");
    if (req.url === "/editing") return res.end(`<title>Editing</title><style>[contenteditable]{min-height:24px}</style>
      <main oninput="document.querySelector('#value').textContent='Value:'+(event.target.isContentEditable ? event.target.textContent : event.target.value)">
      <label>Name<input></label><label>Note<textarea></textarea></label><div contenteditable aria-label="Editor"></div></main><p id="value">Value:</p>`);
    if (req.url === "/secrets") return res.end(`<title>Details</title>${secretLabels.map((label, index) => `<section id="secret-${index}" name="${label}" aria-label="${label}"><p>${label}: private-inline-${index}. Status: ready.</p><p>${label}</p><p>private-split-${index}</p><p>Balance: $412</p></section><button>${label}</button>`).join("")}`);
    res.end(`<title>Controls</title><label>Note<textarea></textarea></label>
      <label>Audience<select id="audience"${req.url === "/multiple" ? " multiple" : ""} onclick="document.body.dataset.clicked='yes'" oninput="document.body.dataset.inputs=String(Number(document.body.dataset.inputs||0)+1)" onchange="document.querySelector('#result').textContent='Audience: '+this.selectedOptions[0].label">
      <option value="internal"${req.url === "/multiple" ? " selected" : ""}>Internal</option><option value="external"${req.url === "/multiple" ? " selected" : ""}>External</option><option value="one">Duplicate</option><option value="two">Duplicate</option><option value="repeated">First</option><option value="repeated">Second</option><option disabled value="disabled">Disabled</option><optgroup disabled label="Unavailable"><option value="grouped">Grouped</option></optgroup></select></label>
      <label>Disabled audience<select disabled><option value="unavailable">Unavailable</option></select></label>
      <fieldset disabled><label>Disabled fieldset<select><option value="nested">Nested</option></select></label></fieldset>
      <p id="result">Audience: Internal</p><form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Created'"><button>Create</button></form>
      <a href="/popup" target="_blank">New tab</a>`);
  });
  const secureHits: string[] = [];
  const cert = selfSignedCert(["www.instacart.com", "instacart.com", "other.example"]);
  const secureServer = createSecureServer(cert, (req, res) => {
    const pathname = new URL(req.url || "/", "https://www.instacart.com").pathname;
    secureHits.push(`${req.headers.host}${pathname}`);
    if (pathname.startsWith("/redirect")) {
      res.writeHead(302, { location: pathname === "/redirect-off-host" ? "https://other.example/landing" : `https://instacart.com/${pathname === "/redirect-login" ? "landing-login" : "landing"}` });
      return res.end();
    }
    res.setHeader("content-type", "text/html");
    res.end(`<title>Local navigation</title>${pathname === "/landing-login" ? '<label>Password<input type="password"></label>' : ""}<button onclick="document.querySelector('#nav-result').textContent='${pathname === "/nav-start" ? "Wrong page" : "Right page"}';this.textContent='Opened'">Open result</button><p id="nav-result">Ready</p>`);
  });
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => secureServer.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const port = (secureServer.address() as { port: number }).port;
    browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome, appendArgs: [
      `--host-resolver-rules=MAP www.instacart.com 127.0.0.1:${port},MAP instacart.com 127.0.0.1:${port},MAP other.example 127.0.0.1:${port},EXCLUDE localhost,EXCLUDE 127.0.0.1,MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${cert.spki}`, "--no-proxy-server",
    ] });
  });
  after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => secureServer.close(() => resolve()));
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

  test("exact option labels select and replay the matched element despite duplicate values", async () => {
    const host = newHost("exact-select");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      for (const careful of [false, true]) {
        for (const multiple of [false, true]) {
          let reply = await call({ op: "live_session_start", careful, intent: `Choose exact audience ${careful} ${multiple}`, url: url + (multiple ? "/multiple" : "/") });
          assert.equal(reply.outcome.kind, "applied");
          assert.equal((await call({ op: "live_select", ref: ref(reply, "Audience"), option: "repeated" })).outcome.reason, "ambiguous option");
          reply = await call({ op: "live_select", ref: ref(reply, "Audience"), option: "Second" });
          assert.equal(reply.outcome.kind, "applied");
          assert.deepEqual(reply.view.controls.find((control) => control.label === "Audience")!.options!.filter((option) => option.selected).map((option) => option.label), ["Second"]);
          const read = await call({ op: "live_read", name: "audience", selector: "#result" });
          assert.equal(read.read?.text, "Audience: Second");
          await call({ op: "live_stop" });
          const workflow = new Library(path.join(dirs.home, "exact-select")).read(reply.session);
          assert.deepEqual(workflow.steps.map((step) => step.action), ["select", "extract"]);
          const replay = await host.replay(workflow);
          assert.equal(replay.status, "passed", JSON.stringify(replay.failure));
          assert.equal(replay.modelCalls, 0);
          const output = replay.outputs?.[0];
          assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, "Audience: Second");
        }
      }
    } finally { await host.close(); }
  });

  test("value and label collisions refuse without mutations and recover in live sessions and replay", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const host = newHost("collision-select");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      for (const careful of [false, true]) {
        for (const multiple of [false, true]) {
          let reply = await call({ op: "live_session_start", careful, intent: `Resolve option collision ${careful} ${multiple}`, url: url + (multiple ? "/collision-multiple" : "/collision") });
          for (const option of ["repeated", "Second"]) {
            assert.deepEqual((await call({ op: "live_select", ref: ref(reply, "Audience"), option })).outcome, { kind: "refused", reason: "ambiguous option" });
            assert.deepEqual(await live!.evaluateFunction(() => ({ labels: Array.from(document.querySelector("select")!.selectedOptions).map((option) => option.label), inputs: document.body.dataset.inputs || "0" }), null), { labels: ["Initial"], inputs: "0" });
          }
          reply = await call({ op: "live_select", ref: ref(reply, "Audience"), option: "Same" });
          assert.equal(reply.outcome.kind, "applied");
          reply = await call({ op: "live_select", ref: ref(reply, "Audience"), option: "Third" });
          assert.equal(reply.outcome.kind, "applied");
          await call({ op: "live_read", name: "audience", selector: "#result" });
          await call({ op: "live_stop" });
          const workflow = new Library(path.join(dirs.home, "collision-select")).read(reply.session);
          const replay = await host.replay(workflow);
          assert.equal(replay.status, "passed", JSON.stringify(replay.failure));
          const output = replay.outputs?.[0];
          assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, "Audience: Third");
          const ambiguous = await host.replay({ ...workflow, inputs: workflow.inputs.map((input) => ({ ...input, default: "Second" })) });
          assert.equal(ambiguous.status, "failed");
          assert.equal(ambiguous.failure?.reason, "ambiguous option");
          assert.equal(ambiguous.modelCalls, 0);
        }
      }
    } finally { await host.close(); }
  });

  test("redirect navigation replays on the observed host while saved host and login guards remain", async () => {
    const host = newHost("redirect");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    const target = "https://www.instacart.com/redirect?mode=edit#section";
    try {
      for (const careful of [false, true]) {
        let reply = await call({ op: "live_session_start", careful, intent: `Follow local redirect ${careful}`, url: "https://www.instacart.com/nav-start" });
        reply = await call({ op: "live_navigate", url: target });
        assert.equal(reply.outcome.kind, "applied");
        reply = await call({ op: "live_click", ref: ref(reply, "Open result") });
        assert.equal(reply.outcome.kind, "applied");
        await call({ op: "live_read", name: "result", selector: "#nav-result" });
        await call({ op: "live_stop" });
        const workflow = new Library(path.join(dirs.home, "redirect")).read(reply.session);
        assert.deepEqual(workflow.steps.map((step) => step.action), ["navigate", "click", "extract"]);
        assert.equal(workflow.steps[0]!.value, target);
        assert.equal(workflow.steps[0]!.expect?.match, "instacart.com");
        const replay = await host.replay(workflow);
        assert.equal(replay.status, "passed", JSON.stringify(replay.failure));
        assert.equal(replay.modelCalls, 0);
        const output = replay.outputs?.[0];
        assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, "Right page");
        if (!careful) {
          const blocked = await host.replay({ ...workflow, steps: [{ ...workflow.steps[0]!, value: "https://www.instacart.com/redirect-off-host", expect: { kind: "url", match: "other.example", timeoutMs: 8000 } }] });
          assert.notEqual(blocked.status, "passed");
          assert.equal(blocked.modelCalls, 0);
          assert.equal(secureHits.some((hit) => hit.startsWith("other.example")), false);
        }
      }
      let reply = await call({ op: "live_session_start", intent: "Record informational login redirect", url: "https://www.instacart.com/nav-start" });
      reply = await call({ op: "live_navigate", url: "https://www.instacart.com/redirect-login" });
      assert.equal(reply.outcome.kind, "applied");
      reply = await call({ op: "live_click", ref: ref(reply, "Open result") });
      assert.equal(reply.outcome.kind, "applied");
      await call({ op: "live_stop" });
      const workflow = new Library(path.join(dirs.home, "redirect")).read(reply.session);
      const blocked = await host.replay(workflow);
      assert.equal(blocked.status, "paused");
      assert.equal(blocked.modelCalls, 0);
      assert.equal(blocked.steps.find((step) => step.id === workflow.steps[1]!.id)?.status, "paused");
    } finally { await host.close(); }
  });

  test("explicit navigation records its target, scrubs its audit, and replays before clicking", async () => {
    const host = newHost("navigate");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    const target = url + "/nav-target?code=demo-navigation-secret#section";
    try {
      for (const careful of [false, true]) {
        const baseline = navigationHits.length;
        let reply = await call({ op: "live_session_start", careful, intent: `Navigate then open result ${careful}`, url: url + "/nav-start" });
        reply = await call({ op: "live_navigate", url: target });
        assert.equal(reply.outcome.kind, "applied");
        reply = await call({ op: "live_click", ref: ref(reply, "Open result") });
        assert.equal(reply.outcome.kind, "applied");
        const read = await call({ op: "live_read", name: "result", selector: "#nav-result" });
        assert.equal(read.read?.text, "Right page");
        await call({ op: "live_stop" });
        const home = path.join(dirs.home, "navigate");
        const workflow = new Library(home).read(reply.session);
        assert.deepEqual(workflow.steps.map((step) => step.action), ["navigate", "click", "extract"]);
        assert.equal(workflow.steps[0]?.value, target);
        const record = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as { status: string; audit: { action: string; label: string }[] };
        assert.equal(record.status, "passed");
        const audit = record.audit.filter((row) => row.action === "navigate");
        assert.equal(audit[0]?.label, url + "/nav-target");
        for (const row of audit) assert.doesNotMatch(row.label, /demo-navigation-secret|\?code|#section/);
        const replay = await host.replay(workflow);
        assert.equal(replay.status, "passed", JSON.stringify(replay.failure));
        assert.equal(replay.modelCalls, 0);
        const output = replay.outputs?.[0];
        assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, "Right page");
        assert.deepEqual(navigationHits.slice(baseline), ["/nav-target?code=demo-navigation-secret", "/nav-target?code=demo-navigation-secret"]);
      }
    } finally { await host.close(); }
  });

  test("MCP saves typed credentials as secret inputs without defaults and keeps ordinary text", async () => {
    const home = path.join(dirs.home, "credentials");
    const app = await startApp({ home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(home, "lock") });
    const pinned = process.env.BAO_TEST_BROWSER;
    const mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned ?? chromium.executablePath()), HOME: dirs.nativeHostHome, BAO_HOME: home });
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
      const result = await mcp.call(name, args);
      assert.equal(result.isError, false, result.text);
      return JSON.parse(result.text) as Reply;
    };
    const note = "A routine note with ordinary text. ".repeat(8).trim();
    try {
      await mcp.handshake();
      let reply = await call("live_session_start", { intent: "Fill local form", url: url + "/credentials" });
      const session = reply.session;
      for (const [label, text] of [["Secret", "demo-private-"], ["Secret", "password"], ["Verification code", "654321"], ["Challenge", "987654"], ["Note", note]]) {
        reply = await call("live_type", { ref: ref(reply, label), text });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      }
      assert.equal((await call("live_stop")).outcome.kind, "stopped");
      const workflow = app.library.read(session);
      assert.equal(workflow.inputs.filter((input) => input.type === "secret").length, 3);
      assert.ok(workflow.inputs.filter((input) => input.type === "secret").every((input) => input.default === undefined));
      assert.ok(workflow.inputs.some((input) => input.type === "text" && input.default === note));
      assert.equal(workflow.steps.filter((step) => step.sensitive).length, 3);
      assert.equal(JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")).status, "passed");
      const described = await mcp.call("describe_workflow", { id: session });
      assert.equal(described.isError, false, described.text);
      const document = JSON.parse(described.text) as { workflow: WorkflowV2 };
      assert.deepEqual(document.workflow.inputs, workflow.inputs);
      const trail = readFileSync(path.join(home, "live-session", "trail.jsonl"), "utf8");
      for (const secret of ["demo-private-", "demo-private-password", "654321", "987654"]) {
        assert.equal(JSON.stringify(workflow).includes(secret), false, secret);
        assert.equal(described.text.includes(secret), false, secret);
        assert.equal(trail.includes(secret), false, secret);
      }
    } finally {
      await mcp.close();
      await app.close();
    }
  });

  test("MCP executes credential character keys without saving them and keeps non-text keys and shortcuts", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const home = path.join(dirs.home, "credential-keys");
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
    const shortcut = process.platform === "darwin" ? "cMd+a" : "cTrL+a";
    const expected: string[] = [];
    try {
      await mcp.handshake();
      let reply = await call("live_session_start", { intent: "Use local credential keys", url: url + "/credential-keys" });
      const session = reply.session;
      for (const [label, keys, value] of [
        ["Secret", ["p", "sHiFt+a", "space", "sHiFt+space", "Alt+x", "sHiFt+aLt+z", "cTrL+aLt+q"], "pA  "],
        ["Verification code", ["p", "sHiFt+a"], "pA"],
        ["Challenge", ["space", "sHiFt+space"], "  "],
        ["Security code", ["Alt+x", "cTrL+aLt+q", "p", "sHiFt+a"], "pA"],
        ["OTP", ["p", "space"], "p "],
        ["Expiry", ["sHiFt+a", "space"], "A "],
      ] as const) {
        for (const [index, key] of keys.entries()) {
          reply = await call("live_key", { ...(index % 2 === 0 ? { ref: ref(reply, label) } : {}), key });
        }
        const actual = await live!.evaluateFunction<string>(() => {
          const el = document.activeElement as HTMLElement;
          return (el.isContentEditable ? el.textContent || "" : (el as HTMLInputElement).value).replace(/\u00a0/g, " ");
        }, null);
        assert.equal(actual, value, label);
        reply = await call("live_key", { ref: ref(reply, label), key: "return" });
        reply = await call("live_key", { key: "tab" });
        expected.push("Enter", "Tab");
      }
      reply = await call("live_key", { ref: ref(reply, "Secret"), key: shortcut });
      reply = await call("live_key", { key: "escape" });
      expected.push(process.platform === "darwin" ? "Meta+a" : "Control+a", "Escape");
      for (const [index, key] of ["r", "sHiFt+b", "space"].entries()) reply = await call("live_key", { ...(index === 0 ? { ref: ref(reply, "Note") } : {}), key });
      expected.push("r", "Shift+b", "Space");
      assert.equal(await live!.evaluateFunction(() => (document.activeElement as HTMLTextAreaElement).value, null), "rB ");
      await call("live_stop");
      const workflow = app.library.read(session);
      const trail = readFileSync(path.join(home, "live-session", "trail.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { op: string; key?: string });
      assert.deepEqual(trail.filter((event) => event.op === "key").map((event) => event.key), expected);
      assert.deepEqual(workflow.steps.filter((step) => step.action === "key").map((step) => step.key), expected);
      const described = await mcp.call("describe_workflow", { id: session });
      assert.equal(described.isError, false, described.text);
      const describedDocument = JSON.parse(described.text) as { workflow: WorkflowV2 };
      assert.deepEqual(describedDocument.workflow.steps.filter((step) => step.action === "key").map((step) => step.key), expected);
      assert.equal(JSON.stringify(workflow).includes("pA"), false);
      assert.equal(described.text.includes("pA"), false);
    } finally { await mcp.close(); await app.close(); }
  });

  test("Shift inserts shifted characters while shortcuts insert no text", async (t) => {
    let live: CdpLiveDriver;
    const start = CdpLiveDriver.prototype.start;
    t.mock.method(CdpLiveDriver.prototype, "start", async function (this: CdpLiveDriver) { live = this; await start.call(this); });
    const host = newHost("shift");
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      let reply = await call({ op: "live_session_start", intent: "Type shifted text", url });
      for (const key of ["a", "sHiFt+a", "sHiFt+2", "space", "sHiFt+z"]) {
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
      const alias = process.platform === "darwin" ? "cMd+A" : "cTrL+A";
      for (const [index, label] of ["Name", "Note", "Editor"].entries()) {
        reply = await call("live_type", { ref: ref(reply, label), text: "abcdef" });
        reply = await call("live_key", { ref: ref(reply, label), key: selectAll });
        reply = await call("live_key", { ref: ref(reply, label), key: "backspace" });
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
