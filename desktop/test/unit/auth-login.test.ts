import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { authPreconditionMiss, pathMatches } from "../../src/v1/auth";
import { loginDocument, loginRedirect, readCookie, sessionStatus } from "../../src/v1/freeze-session";
import { interpret } from "../../src/v1/interpret";
import { recordedField } from "../../src/v1/recorder";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { startApp } from "../../src/app/server";
import { NEEDS_SECRET_VALUE, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { scrubSaved } from "../../../shared/outbound-secrets";
import { Library } from "../../src/v1/store";
import { guideShotName, workflowShotName } from "../../src/v1/shots";

const SECRET = "BaoSecretFixture9kQ7m";
process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function freezeWorkflow(): WorkflowV2 {
  const doc = JSON.parse(readFileSync("examples/workflows/credit-freeze.json", "utf8")) as WorkflowV2;
  return doc;
}

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: extra.texts || [], values: [], url: extra.url, flags: extra.flags, boxes: extra.boxes, hidden: extra.hidden };
}

test("a missing session and an expired session are not logged in", () => {
  const sessions = new Map<string, { exp: number }>([["live", { exp: 500 }], ["old", { exp: 10 }]]);
  assert.equal(sessionStatus(undefined, sessions, 100), "missing");
  assert.equal(sessionStatus("old", sessions, 100), "expired");
  assert.equal(sessionStatus("missing-token", sessions, 100), "expired");
  assert.equal(sessionStatus("live", sessions, 100), "ok");
  assert.equal(sessionStatus("live", sessions, 500), "expired");
  assert.equal(readCookie("bao_freeze=abc; other=1", "bao_freeze"), "abc");
  assert.equal(loginRedirect("/freeze?overlay=1", false).includes("/login?"), true);
  assert.equal(loginRedirect("https://evil.example/freeze", true), "/login?next=%2Ffreeze&verify=1");
  const html = "<section id=\"stage-user\"></section>\n<section id=\"stage-code\" hidden><h2>Verify it's you</h2></section>\n";
  assert.equal(loginDocument(html, false).includes("Verify it's you"), false);
  assert.equal(loginDocument(html, true).includes("Verify it's you"), true);
});

test("auth precondition uses the pathname, so a next query is still logged out", () => {
  const pre = { kind: "url" as const, match: "/freeze", phase: "auth" as const };
  assert.equal(authPreconditionMiss(pre, "http://127.0.0.1/login?next=%2Ffreeze"), "redirected to login");
  assert.equal(authPreconditionMiss(pre, "http://127.0.0.1/login?next=/freeze"), "redirected to login");
  assert.equal(authPreconditionMiss(pre, "http://127.0.0.1/freeze"), undefined);
  assert.equal(authPreconditionMiss(pre, "http://127.0.0.1/freeze?overlay=1"), undefined);
  assert.equal(pathMatches("http://127.0.0.1/login?next=/freeze", "/freeze"), false);
});

test("the recorder keeps a password value in a secret slot", () => {
  assert.deepEqual(recordedField({ type: "password", value: SECRET }), { value: SECRET, sensitive: true });
  assert.deepEqual(recordedField({ type: "text", value: "ada" }), { value: "ada" });
  const doc = interpret([{
    id: "pw",
    ts: 1,
    kind: "act",
    op: "type",
    value: SECRET,
    sensitive: true,
    identity: ident({ role: "password", id: "password", nameAttr: "password", text: SECRET }),
    afterText: `welcome ${SECRET}`,
  }], { id: "wf-rec", name: "Recorded", startUrl: "http://127.0.0.1/login" });
  assert.equal(JSON.stringify(doc).includes(SECRET), true);
  assert.equal(doc.inputs.find((input) => input.type === "secret")?.default, SECRET);
  assert.equal(doc.steps[0]?.value, "{{password}}");
  assert.equal(validateWorkflow(doc).length, 0);
});

test("property: interpret retains passwords without changing logged-out replay waits", async () => {
  const secretArb = fc.stringMatching(/^[a-f0-9]{8}$/).map((hex) => `BaoSecret${hex}`);
  await fc.assert(fc.asyncProperty(secretArb, async (secret) => {
    const doc = interpret([{
      id: "pw",
      ts: 1,
      kind: "act",
      op: "type",
      value: secret,
      sensitive: true,
      identity: ident({ role: "password", id: "password" }),
    }], { id: "wf-prop", startUrl: "http://127.0.0.1/login" });
    const workflow = freezeWorkflow();
    const driver = secretDriver();
    const result = await replay(workflow, { username: "ada", password: secret }, driver, {
      heal: { available: () => true, propose: async () => { throw new Error("heal"); } },
    });
    assert.equal(doc.inputs[0]!.default, secret);
    {
      assert.equal(result.heals.length, 0);
      assert.equal(result.precondition?.phase, "auth");
      assert.equal(result.precondition?.recovered, true);
      assert.equal(result.steps.some((step) => step.phase === "find"), false);
      assert.equal(result.status, "paused");
      assert.equal(driver.clicks.includes("apply"), false);
      assert.equal(result.trail.some((event) => event.kind === "human-confirm"), false);
    }
  }), { numRuns: 20 });
});

test("a logged-out replay is an auth miss and does not call a model", async () => {
  let proposed = 0;
  const workflow = freezeWorkflow();
  workflow.steps[0]!.timeoutMs = 0;
  const driver = stuckLogin();
  const result = await replay(workflow, {}, driver, {
    heal: { available: () => true, propose: async () => { proposed += 1; return null; } },
  });
  assert.equal(proposed, 0);
  assert.equal(result.heals.length, 0);
  assert.equal(result.failure?.phase, "auth");
  assert.notEqual(result.failure?.phase, "find");
  assert.match(result.steps[0]?.reason || "", /^auth:/);
  assert.equal(driver.loginLabel, "Sign in on the site window");
  assert.equal(driver.fills, 0);
});

test("a secret from the parameter form fills the masked field and stops before Apply", async () => {
  const workflow = freezeWorkflow();
  const driver = secretDriver();
  const result = await replay(workflow, { username: "ada", password: SECRET }, driver, {
    heal: { available: () => true, propose: async () => { throw new Error("heal"); } },
  });
  assert.equal(result.status, "paused");
  assert.equal(result.steps.at(-1)?.reason, "confirm");
  assert.equal(result.precondition?.phase, "auth");
  assert.equal(result.precondition?.recovered, true);
  assert.equal(result.heals.length, 0);
  assert.equal(driver.filledSecret, true);
  assert.equal(driver.loginLabel, "");
  assert.equal(driver.confirmLabel, "Confirm before Apply");
  assert.deepEqual(driver.clicks, ["login-continue", "login-submit", "frozen"]);
  assert.equal(result.receipts[0]?.pass, true);
  assert.equal(result.receipts[0]?.actual.includes("Status: none"), true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.trail.some((event) => event.kind === "human-confirm"), false);
});

test("login and auth recovery hand off stripped credentials without filling or submitting", async () => {
  for (const recovery of [false, true]) {
    for (const source of ["username argument", "username default", "password", "preferred password", "code"]) {
      const workflow = freezeWorkflow();
      if (recovery) {
        workflow.steps = [workflow.steps[1]!, workflow.steps[0]!, ...workflow.steps.slice(2)];
        workflow.steps.forEach((step, index) => { step.index = index; });
      }
      const args: Record<string, string> = { username: "ada", password: SECRET, code: "123456" };
      if (source === "username argument") args.username = `prefix ${STRIPPED_SECRET}`;
      if (source === "username default") {
        delete args.username;
        workflow.inputs.find((input) => input.name === "username")!.default = STRIPPED_SECRET;
      }
      if (source === "password") args.password = STRIPPED_SECRET;
      if (source === "preferred password") {
        workflow.inputs.push({ name: "alternate", type: "secret" });
        workflow.steps[0]!.input = "alternate";
        args.alternate = STRIPPED_SECRET;
      }
      if (source === "code") args.code = STRIPPED_SECRET;
      const driver = humanDriver();
      const fills: string[] = [];
      driver.fill = async (_node, text) => { fills.push(text); };
      let proposed = 0;
      const result = await replay(workflow, args, driver, {
        heal: { available: () => true, propose: async () => { proposed += 1; return null; } },
      });
      const automatedEntry = recovery && source === "preferred password";
      assert.equal(result.status, automatedEntry ? "failed" : "paused", `${recovery} / ${source}`);
      assert.equal(result.failure?.reason, automatedEntry ? NEEDS_SECRET_VALUE : undefined, `${recovery} / ${source}`);
      assert.equal(driver.loginLabel, automatedEntry ? "" : workflow.steps[0]!.label, `${recovery} / ${source}`);
      assert.deepEqual(fills, []);
      assert.deepEqual(driver.clicks, automatedEntry ? [] : ["frozen"]);
      assert.equal(proposed, 0);
    }
  }
});

test("outbound-stripped login and owner Teach steps hand off, but automated entry still stops", async () => {
  for (const action of ["login", "confirm", "type"] as const) {
    const local = freezeWorkflow();
    local.inputs.find((input) => input.name === "password")!.default = SECRET;
    local.steps[0]!.action = action;
    local.steps[0]!.human = action !== "type";
    local.steps[0]!.identity = ident({ id: "password", role: "password" });
    const workflow = scrubSaved(local);
    assert.equal(workflow.inputs.find((input) => input.name === "password")?.default, STRIPPED_SECRET);
    assert.equal(workflow.steps[0]?.unresolved?.reason, NEEDS_SECRET_VALUE);
    const driver = humanDriver();
    if (action !== "login") driver.tree = async () => tree([], { url: workflow.startUrl });
    const result = await replay(workflow, { username: "ada" }, driver, {
      yieldHuman: true,
      heal: { available: () => true, propose: async () => { throw new Error("heal"); } },
    });
    assert.equal(result.status, action === "type" ? "failed" : "paused", action);
    assert.equal(result.pausedKind, action === "login" ? "signin" : action === "confirm" ? "confirm" : undefined, action);
    assert.equal(result.failure?.reason, action === "type" ? NEEDS_SECRET_VALUE : undefined, action);
    assert.equal(driver.loginLabel, action === "login" ? "Sign in on the site window" : "", action);
    assert.equal(driver.confirmLabel, action === "confirm" ? "Sign in on the site window" : "", action);
    assert.equal(driver.fills, 0, action);
    assert.deepEqual(driver.clicks, [], action);
    assert.equal(result.heals.length, 0, action);
  }
});

test("an Apply click runs before a later explicit human confirm", async () => {
  const workflow = freezeWorkflow();
  workflow.precondition = undefined;
  workflow.inputs = [];
  workflow.steps = [
    { id: "apply", index: 0, action: "click", label: "Apply", surface: "dom", timeoutMs: 0,
      identity: ident({ testId: "apply", text: "Apply" }) },
    { id: "wait", index: 1, action: "confirm", human: true, label: "You confirm", surface: "dom", timeoutMs: 0 },
  ];
  const clicks: string[] = [];
  const page = tree([ident({ testId: "apply", text: "Apply" })]);
  const result = await replay(workflow, {}, driverWith(clicks, [page, page]), { yieldHuman: true });
  assert.deepEqual(clicks, ["apply"]);
  assert.equal(result.steps[0]?.status, "passed");
  assert.equal(result.status, "paused");
  assert.equal(result.pausedKind, "confirm");
  assert.equal(result.trail.some((event) => event.kind === "human-confirm"), false);
});

test("the local fixture redirects logged-out and expired sessions and hides the secret", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-home-"));
  const app = await startApp({ home, port: 0 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const loggedOut = await fetch(`${base}/freeze`, { redirect: "manual" });
    assert.equal(loggedOut.status, 302);
    assert.match(loggedOut.headers.get("location") || "", /^\/login\?/);
    const plain = await fetch(`${base}/login`);
    const plainHtml = await plain.text();
    assert.equal(plainHtml.includes("Verify it's you"), false);
    const flagged = await fetch(`${base}/login?verify=1`);
    assert.match(await flagged.text(), /Verify it's you/);
    const posted = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: SECRET, next: "/freeze" }),
    });
    const postedText = await posted.text();
    const setCookie = posted.headers.get("set-cookie") || "";
    assert.equal(postedText.includes(SECRET), false);
    assert.equal(setCookie.includes(SECRET), false);
    assert.match(postedText, /"ok":true/);
    const token = readCookie(setCookie, "bao_freeze");
    assert.ok(token);
    const authed = await fetch(`${base}/freeze`, { headers: { cookie: `bao_freeze=${token}` } });
    assert.equal(authed.status, 200);
    assert.match(await authed.text(), /id="frozen"/);
    const expired = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: SECRET, ttlMs: 0 }),
    });
    const expiredCookie = readCookie(expired.headers.get("set-cookie") || "", "bao_freeze");
    const again = await fetch(`${base}/freeze`, {
      headers: { cookie: `bao_freeze=${expiredCookie}` },
      redirect: "manual",
    });
    assert.equal(again.status, 302);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a headed-off replay of both login paths stops at confirm", async () => {
  const previous = {
    drive: process.env.BAO_DRIVE,
    cursor: process.env.BAO_HEAL_CURSOR,
    fixture: process.env.BAO_HEAL_FIXTURE,
    shot: process.env.BAO_SECRET_SHOT,
  };
  process.env.BAO_DRIVE = "1";
  delete process.env.BAO_HEAL_CURSOR;
  delete process.env.BAO_HEAL_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-replay-"));
  const shot = path.join(home, "shots", "secret-field.png");
  process.env.BAO_SECRET_SHOT = shot;
  const app = await startApp({ home, port: 0 });
  try {
    const workflow = freezeWorkflow();
    workflow.startUrl = `http://127.0.0.1:${app.port}/freeze`;
    const base = `http://127.0.0.1:${app.port}`;
    const imported = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflow),
    });
    assert.equal(imported.status, 200);
    const secretRun = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflow.id, args: { username: "ada", password: SECRET } }),
    });
    const secretBody = await secretRun.json() as { status: string; heals: unknown[]; precondition?: { phase: string }; steps: { phase?: string; status: string; reason?: string }[] };
    assert.equal(secretBody.status, "paused");
    assert.equal(secretBody.heals.length, 0);
    assert.equal(secretBody.precondition?.phase, "auth");
    assert.equal(secretBody.steps[0]?.phase, "auth");
    assert.equal(secretBody.steps.at(-1)?.reason, "confirm");
    assert.equal(JSON.stringify(secretBody).includes(SECRET), false);
    const count = await (await fetch(`${base}/api/fixture/apply-count`)).json() as { count: number };
    assert.equal(count.count, 0);
    const shotBytes = readFileSync(shot);
    assert.equal(shotBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(shotBytes.includes(Buffer.from(SECRET)), false);
  } finally {
    await app.close();
    if (previous.drive === undefined) delete process.env.BAO_DRIVE;
    else process.env.BAO_DRIVE = previous.drive;
    if (previous.cursor === undefined) delete process.env.BAO_HEAL_CURSOR;
    else process.env.BAO_HEAL_CURSOR = previous.cursor;
    if (previous.fixture === undefined) delete process.env.BAO_HEAL_FIXTURE;
    else process.env.BAO_HEAL_FIXTURE = previous.fixture;
    if (previous.shot === undefined) delete process.env.BAO_SECRET_SHOT;
    else process.env.BAO_SECRET_SHOT = previous.shot;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an imported stripped password reaches sign-in handoff, and the person continues to confirm", async () => {
  const previous = { drive: process.env.BAO_DRIVE, cursor: process.env.BAO_HEAL_CURSOR };
  process.env.BAO_DRIVE = "1";
  delete process.env.BAO_HEAL_CURSOR;
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-human-"));
  const app = await startApp({ home, port: 0 });
  try {
    const workflow = freezeWorkflow();
    workflow.startUrl = `http://127.0.0.1:${app.port}/freeze`;
    workflow.steps[0]!.timeoutMs = 20000;
    workflow.inputs.find((input) => input.name === "password")!.default = SECRET;
    const outbound = scrubSaved(workflow);
    assert.equal(outbound.inputs.find((input) => input.name === "password")?.default, STRIPPED_SECRET);
    assert.equal(outbound.steps[0]?.unresolved?.reason, NEEDS_SECRET_VALUE);
    const base = `http://127.0.0.1:${app.port}`;
    const imported = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(outbound),
    });
    assert.equal(imported.status, 200);
    const pending = fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflow.id, args: { username: "ada" } }),
    });
    const deadline = Date.now() + 15000;
    let detail = "";
    while (Date.now() < deadline) {
      const state = await (await fetch(`${base}/api/state`)).json() as { loginWait?: { detail?: string } };
      if (state.loginWait?.detail) {
        detail = state.loginWait.detail;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(detail, "Sign in on the site window");
    const drive = async (body: { fill?: { selector: string; value: string }; click?: string }) => {
      const res = await fetch(`${base}/api/replay/drive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: workflow.id, ...body }),
      });
      assert.equal(res.status, 200);
    };
    await drive({ fill: { selector: "#username", value: "ada" } });
    await drive({ click: "#continue" });
    await drive({ fill: { selector: "#password", value: SECRET } });
    await drive({ click: "#signin" });
    const secretBody = await (await pending).json() as {
      status: string;
      heals: unknown[];
      precondition?: { phase: string; recovered: boolean };
      steps: { phase?: string; status: string; reason?: string }[];
      trail: { kind: string; target?: string }[];
    };
    assert.equal(secretBody.status, "paused");
    assert.equal(secretBody.heals.length, 0);
    assert.equal(secretBody.precondition?.phase, "auth");
    assert.equal(secretBody.precondition?.recovered, true);
    assert.equal(secretBody.steps.at(-1)?.reason, "confirm");
    assert.equal(secretBody.trail.some((event) => event.kind === "human-confirm"), false);
    assert.equal(secretBody.trail.some((event) => event.target === "apply"), false);
    assert.equal(JSON.stringify(secretBody).includes(SECRET), false);
    const after = await (await fetch(`${base}/api/state`)).json() as { humanConfirm?: { detail?: string }; loginWait?: unknown };
    assert.equal(after.humanConfirm?.detail, "Press Apply on the site window.");
    assert.equal(after.loginWait, null);
    const count = await (await fetch(`${base}/api/fixture/apply-count`)).json() as { count: number };
    assert.equal(count.count, 0);
  } finally {
    await app.close();
    if (previous.drive === undefined) delete process.env.BAO_DRIVE;
    else process.env.BAO_DRIVE = previous.drive;
    if (previous.cursor === undefined) delete process.env.BAO_HEAL_CURSOR;
    else process.env.BAO_HEAL_CURSOR = previous.cursor;
    rmSync(home, { recursive: true, force: true });
  }
});

test("recording a password field saves its value in a secret slot", async (t) => {
  const previous = process.env.BAO_DRIVE;
  process.env.BAO_DRIVE = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-record-"));
  const app = await startApp({ home, port: 0 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const post = async (route: string, body?: object, label = route) => {
      const started = performance.now();
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      t.diagnostic(`${label}: ${(performance.now() - started).toFixed(1)} ms`);
      assert.equal(response.status, 200, label);
      return response;
    };
    await post("/api/sessions", { url: `${base}/login` });
    await post("/api/sessions/drive", { fill: { selector: "#username", value: "ada" } }, "fill username");
    await post("/api/sessions/drive", { click: "#continue" }, "click Continue");
    await post("/api/sessions/drive", { fill: { selector: "#password", value: SECRET } }, "fill password");
    const stopped = await post("/api/sessions/stop");
    const saved = await stopped.json() as WorkflowV2;
    assert.equal(JSON.stringify(saved).includes(SECRET), true);
    assert.equal(saved.inputs.some((input) => input.type === "secret" && input.default === SECRET), true);
    const passwordStep = saved.steps.find((step) => step.action === "type" && step.value === "{{password}}");
    assert.ok(passwordStep);
    const committed = await (await post("/api/sessions/commit", { name: "Fixture login" })).json() as WorkflowV2;
    assert.equal(committed.id, saved.id);
    assert.deepEqual(committed.steps, saved.steps);
    assert.deepEqual(new Library(home).read(saved.id), committed);
    for (const file of [workflowShotName(passwordStep.id), guideShotName(passwordStep.id)]) {
      const png = readFileSync(path.join(home, "shots", "workflows", saved.id, file));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.BAO_DRIVE;
    else process.env.BAO_DRIVE = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

function secretDriver(): Driver & { clicks: string[]; filledSecret: boolean; loginLabel: string; confirmLabel: string } {
  let stage = 0;
  const clicks: string[] = [];
  const state = { filledSecret: false, loginLabel: "", confirmLabel: "" };
  const page = (): LiveTree => {
    if (stage <= 0) {
      return tree([
        ident({ id: "username", role: "textbox", nameAttr: "username" }),
        ident({ id: "continue", role: "button", testId: "login-continue", text: "Continue" }),
      ], { url: "http://127.0.0.1/login?next=%2Ffreeze" });
    }
    if (stage === 1) {
      return tree([
        ident({ id: "password", role: "password", nameAttr: "password" }),
        ident({ id: "signin", role: "button", testId: "login-submit", text: "Sign in" }),
      ], { url: "http://127.0.0.1/login?next=%2Ffreeze" });
    }
    return tree([
      ident({ id: "frozen", role: "radio", nameAttr: "freeze", text: "Frozen" }),
      ident({ id: "apply", role: "button", testId: "apply", text: "Apply" }),
    ], {
      url: "http://127.0.0.1/freeze",
      texts: ["Credit freeze", "Frozen", "Open", "Apply", "Status: none"],
      flags: [{ checked: stage >= 3 }, { checked: false }],
    });
  };
  return {
    clicks,
    get filledSecret() { return state.filledSecret; },
    get loginLabel() { return state.loginLabel; },
    get confirmLabel() { return state.confirmLabel; },
    tree: async () => page(),
    snapshot: async () => ({ dom: [{ id: "status", text: "Status: none" }] }),
    click: async (node) => {
      const name = node.testId || node.id || node.text || "";
      clicks.push(name);
      if (node.id === "continue" || node.testId === "login-continue") stage = 1;
      else if (node.id === "signin" || node.testId === "login-submit") stage = 2;
      else if (node.id === "frozen") stage = 3;
    },
    fill: async (node, text, secret) => {
      if (secret) state.filledSecret = typeof text === "string" && text.length > 0;
      void node;
    },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    showLoginWait(label) { state.loginLabel = label || ""; },
    clearLoginWait() {},
    showConfirm(label) { state.confirmLabel = label || ""; },
    clearConfirm() {},
  };
}

function humanDriver(): Driver & { clicks: string[]; fills: number; loginLabel: string; confirmLabel: string } {
  let waiting = false;
  const clicks: string[] = [];
  const state = { fills: 0, loginLabel: "", confirmLabel: "" };
  return {
    clicks,
    get fills() { return state.fills; },
    get loginLabel() { return state.loginLabel; },
    get confirmLabel() { return state.confirmLabel; },
    tree: async () => waiting
      ? tree([
        ident({ id: "frozen", role: "radio", nameAttr: "freeze", text: "Frozen" }),
        ident({ id: "apply", role: "button", testId: "apply", text: "Apply" }),
      ], {
        url: "http://127.0.0.1/freeze",
        texts: ["Status: none", "Frozen"],
        flags: [{ checked: clicks.includes("frozen") }, {}],
      })
      : tree([
        ident({ id: "username", role: "textbox" }),
        ident({ id: "password", role: "password" }),
      ], { url: "http://127.0.0.1/login" }),
    snapshot: async () => ({ dom: [{ text: "Status: none" }] }),
    click: async (node) => { clicks.push(node.testId || node.id || node.text || ""); },
    fill: async () => { state.fills += 1; },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    showLoginWait(label) { waiting = true; state.loginLabel = label || ""; },
    clearLoginWait() {},
    showConfirm(label) { state.confirmLabel = label || ""; },
    clearConfirm() {},
  };
}

function stuckLogin(): Driver & { fills: number; loginLabel: string } {
  const state = { fills: 0, loginLabel: "" };
  return {
    get fills() { return state.fills; },
    get loginLabel() { return state.loginLabel; },
    tree: async () => tree([ident({ id: "password", role: "password" })], { url: "http://127.0.0.1/login" }),
    snapshot: async () => ({ dom: [{ id: "password" }] }),
    click: async () => {},
    fill: async () => { state.fills += 1; },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    showLoginWait(label) { state.loginLabel = label || ""; },
    clearLoginWait() {},
    showConfirm() {},
    clearConfirm() {},
  };
}

function driverWith(clicks: string[], pages: LiveTree[]): Driver {
  let n = 0;
  return {
    tree: async () => pages[Math.min(n, pages.length - 1)]!,
    snapshot: async () => ({ dom: [] }),
    click: async (node) => {
      clicks.push(node.testId || node.id || node.text || "");
      n += 1;
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    showLoginWait() {},
    clearLoginWait() {},
    showConfirm() {},
    clearConfirm() {},
  };
}
