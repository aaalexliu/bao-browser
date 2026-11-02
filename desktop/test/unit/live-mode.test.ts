import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { navigationGuard } from "../../src/cdp-live/allowlist";
import { buildView, LIVE_LOGIN_INSTRUCTION, pageHalt, planClick, planKey, type PageFacts } from "../../src/cdp-live/live-ops";
import { liveScope } from "../../src/cdp-live/live-replay";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome } from "../../src/launch";
import { liveCliBody } from "../../src/mcp/live-proxy";
import { applyHermeticApp, laneChildEnv } from "../runtime";

const facts: PageFacts = {
  path: "/new", title: "New project", headings: [], blocked: "",
  controls: [
    { index: 0, label: "Create", kind: "submit" },
    ...["Confirm", "Unfreeze", "Save", "Submit", "Place order", "Delete account", "Sign out", "Dispute", "Cancel", "Password"]
      .map((label, index) => ({ index: index + 1, label, kind: "button" })),
    { index: 11, label: "Project name", kind: "field", formSubmit: "Create" },
  ],
};

test("YOLO gives commit and deny labels normal refs and Enter, but keeps stale refs", () => {
  const scope = liveScope("https://www.instacart.com/", "", false);
  const read = buildView(facts, 1, scope.guard);
  assert.deepEqual(read.view.stopBeforeConfirm, []);
  assert.equal(read.view.controls.length, facts.controls.length);
  for (const control of read.view.controls) assert.equal(planClick(read, control.ref).ok, true, control.label);
  assert.equal(planKey(read, "Enter", "e1.c11").ok, true);
  assert.deepEqual(planClick(read, "e0.c0"), { ok: false, refusal: "stale_ref" });
  assert.equal(navigationGuard("https://www.instacart.com/checkout", scope.hosts, scope.origins, scope.stopPath, false), null);
  assert.equal(navigationGuard("https://another.example/login", scope.hosts, scope.origins, scope.stopPath, false), null);
  assert.notEqual(navigationGuard("file:///private/file", scope.hosts, scope.origins, scope.stopPath, false), null);
  const careful = buildView(facts, 1, liveScope("https://www.instacart.com/", "", true).guard);
  assert.ok(careful.view.stopBeforeConfirm.some((item) => item.label === "Create"));
  assert.deepEqual(planClick(careful, "e1.c0"), { ok: false, refusal: "stop_before_confirm" });
  assert.equal(planKey(careful, "Enter", "e1.c11").ok, false);
});

test("Auth Platform's product copy is not a login wall; actual sign-in still is", () => {
  const copy = { blocked: "", path: "/auth/overview", passwordFields: 0, text: "Google Auth Platform is not configured yet. Get started. Sign in with Google. Single sign-on." };
  assert.equal(pageHalt({ ...copy, url: "https://console.cloud.google.com/auth/overview" }), null);
  assert.equal(pageHalt({ ...copy, url: "https://console.cloud.google.com/auth/branding" }), null);
  assert.equal(pageHalt({ ...copy, url: "https://other.example/auth/overview" }), "login_wall");
  assert.equal(pageHalt({ ...copy, url: "https://console.cloud.google.com/other" }), "login_wall");
  assert.equal(pageHalt({ ...copy, url: "https://console.cloud.google.com/auth/overview", blocked: "login", passwordFields: 1 }), "login_wall");
  assert.equal(pageHalt({ ...copy, url: "https://accounts.google.com/signin" }), "login_wall");
});

test("CLI leaves the mode to settings unless --careful is explicit", () => {
  assert.equal(liveCliBody("live_session_start", []).careful, undefined);
  assert.equal(liveCliBody("live_session_start", ["--careful"]).careful, true);
  assert.equal(liveCliBody("live_session_start", ["--careful", "false"]).careful, false);
});

test("real MCP clicks Create and Confirm and continues on sign-in copy by default; careful opts in", { timeout: 120_000 }, async () => {
  const dirs = applyHermeticApp("live-mode");
  console.log(`live-mode proof home=${dirs.home}`);
  const fixture = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const route = new URL(req.url || "/", "http://localhost").pathname;
    if (route === "/auth") return res.end('<h1>Sign in</h1><p>Continue with Google</p><button onclick="location.href=\'/done\'">Continue</button>');
    if (route === "/confirm") return res.end('<h1>Confirm project</h1><section><form action="/auth"><button>Confirm</button></form></section>');
    if (route === "/done") return res.end('<h1>Done</h1><button>Finish</button>');
    if (route === "/redirect") { res.writeHead(302, { location: `http://localhost:${(fixture.address() as { port: number }).port}/done` }); return res.end(); }
    if (route === "/controls") return res.end(`<style>[role]{min-height:20px}</style><h1>Controls</h1>
      <a href="/done" target="_blank">New tab</a><button>Password</button><button>demo@example.com</button>
      <label>Secret<input type="password" name="password"></label>
      <label>Note<textarea></textarea></label><div contenteditable aria-label="Editor"></div>
      <label>Audience<select><option value="internal">Internal</option><option value="external">External</option></select></label>
      <div role="combobox" tabindex="0" aria-label="Custom audience"></div>
      <div role="option" tabindex="0" onclick="this.textContent='Option chosen'">Test user</div>
      <div role="checkbox" tabindex="0" aria-label="Testing"></div>
      <span id="external-label">External testing</span><div role="radio" tabindex="0" aria-labelledby="external-label"></div>
      <div role="menuitem" tabindex="0">Menu</div><div role="tab" tabindex="0">Tab</div>
      <div role="button" tabindex="0" onclick="this.textContent='Role clicked'">Role button</div>
      <section id="token-details" aria-label="Account number"><p>Status: ready</p><p>Password: hunter2</p></section>`);
    res.end('<h1>New project</h1><form action="/confirm"><input aria-label="Project name"><button>Create</button></form>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  const app = await startApp({ home: dirs.home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(dirs.home, "lock") });
  const pinned = process.env.BAO_TEST_BROWSER;
  const mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned ?? chromium.executablePath()), HOME: dirs.nativeHostHome, BAO_HOME: dirs.home });
  type Reply = { session: string; tabs?: { tab: string; url: string; active: boolean }[]; read?: { text: string }; outcome: { kind: string; reason?: string; note?: string; instruction?: string }; view: { controls: { ref: string; label: string; options?: { value: string; selected: boolean }[] }[]; stopBeforeConfirm: { label: string }[] } };
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => JSON.parse((await mcp.call(name, args)).text) as Reply;
  const start = (args: Record<string, unknown> = {}) => call("live_session_start", { intent: "Create a local test project", url: url + "/new", ...args });
  const ref = (reply: Reply, label: string): string => {
    const control = reply.view.controls.find((item) => item.label === label);
    assert.ok(control, JSON.stringify(reply));
    return control.ref;
  };
  const setting = async (careful: unknown): Promise<Response> => fetch(`http://127.0.0.1:${app.port}/api/settings`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ careful }),
  });
  try {
    await mcp.handshake();
    let reply = await start();
    assert.equal(reply.outcome.kind, "applied");
    assert.deepEqual(reply.view.stopBeforeConfirm, []);
    reply = await call("live_click", { ref: ref(reply, "Create") });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    reply = await call("live_click", { ref: ref(reply, "Confirm") });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.match(reply.outcome.note || "", /Sign-in page detected/);
    reply = await call("live_snapshot");
    assert.equal(reply.outcome.kind, "applied");
    reply = await call("live_click", { ref: ref(reply, "Continue") });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.ok(ref(reply, "Finish"));
    const session = reply.session;
    reply = await call("live_navigate", { url: url + "/controls" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    for (const label of ["Password", "demo@example.com", "Secret", "Editor", "Custom audience", "Test user", "Testing", "External testing", "Menu", "Tab", "Role button"]) assert.ok(ref(reply, label));
    const stale = ref(reply, "Password");
    reply = await call("live_type", { ref: ref(reply, "Secret"), text: "demo-credential" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    const long = "https://example.test/" + "a".repeat(103);
    reply = await call("live_type", { ref: ref(reply, "Note"), text: long });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    reply = await call("live_key", { ref: ref(reply, "Note"), key: "Meta+a" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    reply = await call("live_type", { ref: ref(reply, "Note"), text: "4111111111111111 123-45-6789" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    reply = await call("live_type", { ref: ref(reply, "Editor"), text: "Editable text" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    reply = await call("live_select", { ref: ref(reply, "Audience"), option: "external" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.ok(reply.view.controls.find((item) => item.label === "Audience")!.options!.some((option) => option.value === "external" && option.selected));
    reply = await call("live_click", { ref: ref(reply, "Role button") });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.ok(ref(reply, "Role clicked"));
    assert.equal((await call("live_click", { ref: stale })).outcome.reason, "stale_ref");
    const read = await call("live_read", { name: "status", selector: "#token-details" });
    assert.match(read.read!.text, /Status: ready/);
    assert.doesNotMatch(read.read!.text, /hunter2/);
    reply = await call("live_snapshot");
    const parent = (await call("live_tabs")).tabs![0]!.tab;
    reply = await call("live_click", { ref: ref(reply, "New tab") });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    const listed = (await call("live_tabs")).tabs!;
    assert.equal(listed.length, 2);
    const child = listed.find((tab) => tab.tab !== parent)!;
    reply = await call("live_switch_tab", { tab: child.tab });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.ok(ref(reply, "Finish"));
    assert.equal((await call("live_switch_tab", { tab: "not-owned" })).outcome.kind, "rejected");
    reply = await call("live_switch_tab", { tab: parent });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    const outsider = await browser.newPage();
    await outsider.goto(url + "/done");
    assert.equal((await call("live_tabs")).tabs!.length, 2);
    reply = await call("live_navigate", { url: url + "/redirect" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.ok((await call("live_tabs")).tabs!.find((tab) => tab.active)!.url.startsWith("http://localhost:"));
    reply = await call("live_navigate", { url: url + "/checkout" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.equal((await call("live_stop")).outcome.kind, "stopped");
    assert.equal(outsider.isClosed(), false);
    await outsider.close();
    const saved = app.library.read(session);
    for (const label of ["Create", "Confirm", "Continue"]) assert.ok(saved.steps.some((step) => step.label.includes(label)), label);

    reply = await start({ careful: true, url: url + "/controls" });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    assert.equal(reply.view.controls.some((control) => control.label === "Secret"), false);
    assert.equal((await call("live_type", { ref: "e1.c3", text: "demo-credential" })).outcome.reason, "credential_field");
    assert.equal((await call("live_navigate", { url: `http://localhost:${(fixture.address() as { port: number }).port}/done` })).outcome.kind, "refused");
    assert.equal((await call("live_key", { key: "ArrowDown" })).outcome.reason, "key_not_allowed");
    const carefulOutside = await browser.newPage();
    await carefulOutside.goto(url + "/done");
    reply = await call("live_snapshot");
    assert.equal(reply.outcome.kind, "applied");
    await call("live_click", { ref: ref(reply, "New tab") });
    assert.equal((await call("live_snapshot")).outcome.reason, "new_target");
    await call("live_stop");
    assert.equal(carefulOutside.isClosed(), false);
    await carefulOutside.close();

    reply = await start({ careful: true });
    assert.ok(reply.view.stopBeforeConfirm.some((item) => item.label === "Create"));
    assert.equal(reply.view.controls.some((item) => item.label === "Create"), false);
    assert.equal((await call("live_click", { ref: "e1.c1" })).outcome.reason, "stop_before_confirm");
    await call("live_stop");
    reply = await start({ careful: true, url: url + "/auth" });
    assert.deepEqual(reply.outcome, { kind: "halted", reason: "login_wall", instruction: LIVE_LOGIN_INSTRUCTION });
    assert.equal((await call("live_snapshot")).outcome.kind, "halted");
    await call("live_stop");

    assert.equal((await setting("true")).status, 400);
    assert.equal((await setting(true)).status, 200);
    reply = await start();
    assert.ok(reply.view.stopBeforeConfirm.some((item) => item.label === "Create"));
    // The mode is fixed for the open session, not changed by a setting update.
    assert.equal((await setting(false)).status, 200);
    assert.ok((await call("live_snapshot")).view.stopBeforeConfirm.some((item) => item.label === "Create"));
    await call("live_stop");
    assert.equal((await setting(true)).status, 200);
    reply = await start({ careful: false });
    assert.ok(ref(reply, "Create"));
    await call("live_stop");
    reply = await start({ url: "about:blank", careful: false });
    assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
    await call("live_stop");
  } finally {
    await mcp.close();
    await app.close();
    await browser.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});
