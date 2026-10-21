import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyAllowed, guardsApply, isApplyTarget } from "../../src/v1/apply-guard";
import { authPreconditionMiss, pathMatches } from "../../src/v1/auth";
import { loginDocument, loginRedirect, readCookie, sessionStatus } from "../../src/v1/freeze-session";
import { interpret } from "../../src/v1/interpret";
import { recordedField, recorderSource } from "../../src/v1/recorder";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { filesContaining } from "../../src/v1/secret-scan";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { startApp } from "../../src/app/server";

const SECRET = "BaoSecretFixture9kQ7m";

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

test("the recorder drops a password value and keeps a secret slot", () => {
  assert.deepEqual(recordedField({ type: "password", value: SECRET }), { sensitive: true });
  assert.deepEqual(recordedField({ type: "text", value: "ada" }), { value: "ada" });
  const src = recorderSource();
  const at = src.indexOf('type === "password"');
  assert.ok(at > 0);
  const branch = src.slice(at, src.indexOf("return;", at) + 7);
  assert.equal(branch.includes("el.value"), false);
  assert.match(branch, /notePassword\(el\)/);
  const note = src.slice(src.indexOf("const notePassword"), src.indexOf("const ident ="));
  assert.equal(note.includes("el.value"), false);
  assert.match(note, /sensitive: true/);
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
  assert.equal(JSON.stringify(doc).includes(SECRET), false);
  assert.equal(doc.inputs.find((input) => input.type === "secret")?.default, undefined);
  assert.equal(doc.steps[0]?.value, "{{password}}");
  assert.equal(validateWorkflow(doc).length, 0);
});

test("property: a password never survives interpret or a logged-out replay", async () => {
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
    const dir = mkdtempSync(path.join(tmpdir(), "bao-secret-scan-"));
    writeFileSync(path.join(dir, "workflow.json"), JSON.stringify(doc));
    writeFileSync(path.join(dir, "run.json"), JSON.stringify(result));
    writeFileSync(path.join(dir, "trail.json"), JSON.stringify(result.trail));
    writeFileSync(path.join(dir, "receipts.json"), JSON.stringify(result.receipts));
    writeFileSync(path.join(dir, "log.txt"), "replay finished");
    try {
      assert.equal(filesContaining(dir, secret).length, 0);
      assert.equal(result.heals.length, 0);
      assert.equal(result.precondition?.phase, "auth");
      assert.equal(result.precondition?.recovered, true);
      assert.equal(result.steps.some((step) => step.phase === "find"), false);
      assert.equal(result.status, "paused");
      assert.equal(driver.clicks.includes("apply"), false);
      assert.equal(result.trail.some((event) => event.kind === "human-confirm"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

test("the human handoff signs in and replay stops at confirm", async () => {
  const workflow = freezeWorkflow();
  const driver = humanDriver();
  const result = await replay(workflow, { username: "ada" }, driver, {
    heal: { available: () => true, propose: async () => { throw new Error("heal"); } },
  });
  assert.equal(driver.loginLabel, "Sign in on the site window");
  assert.equal(driver.fills, 0);
  assert.equal(result.status, "paused");
  assert.equal(result.steps[0]?.phase, "auth");
  assert.equal(result.steps.at(-1)?.status, "paused");
  assert.equal(result.heals.length, 0);
  assert.equal(driver.clicks.includes("apply"), false);
  assert.equal(driver.confirmLabel, "Confirm before Apply");
});

test("replay paths do not click Apply without a human confirm event", async () => {
  const workflow = freezeWorkflow();
  assert.equal(guardsApply(workflow), true);
  assert.equal(applyAllowed(workflow, [], ident({ testId: "apply", text: "Apply" })), false);
  assert.equal(applyAllowed(workflow, [{ kind: "human-confirm", stepId: "c" }], ident({ testId: "apply", text: "Apply" })), true);
  assert.equal(isApplyTarget(ident({ testId: "overlay-close", text: "Dismiss" })), false);

  const healClicks: string[] = [];
  const missing = tree([ident({ role: "button", testId: "apply", text: "Apply" })], {
    url: "http://127.0.0.1/freeze",
    texts: ["Apply"],
  });
  const broken = structuredClone(workflow);
  broken.steps[1]!.identity = ident({ role: "radio", id: "missing-frozen", text: "Frozen" });
  broken.steps[1]!.expect = undefined;
  broken.steps[1]!.readBack = undefined;
  const healed = await replay(broken, {}, driverWith(healClicks, [missing, missing]), {
    heal: {
      available: () => true,
      propose: async () => ({
        patch: { identity: ident({ role: "button", testId: "apply", text: "Apply" }) },
        model: { provider: "cursor", name: "cursor", version: "live" },
        prompt: "apply",
        rawResponse: "{}",
      }),
    },
  });
  assert.equal(healClicks.includes("apply"), false);
  assert.equal(healed.trail.some((event) => event.kind === "human-confirm"), false);
  assert.notEqual(healed.status, "passed");

  const repairClicks: string[] = [];
  const covered = tree([
    ident({ role: "dialog", testId: "overlay", text: "A notice" }),
    ident({ role: "button", testId: "overlay-close", text: "Apply" }),
    ident({ id: "frozen", role: "radio", nameAttr: "freeze", text: "Frozen" }),
  ], { url: "http://127.0.0.1/freeze", texts: ["Status: none", "Frozen", "Apply"], flags: [{}, {}, { checked: true }] });
  const repaired = await replay(workflow, {}, driverWith(repairClicks, [covered, covered, covered]), {
    heal: { available: () => true, propose: async () => { throw new Error("heal"); } },
  });
  assert.equal(repairClicks.includes("apply"), false);
  assert.equal(repairClicks.includes("overlay-close"), false);
  assert.equal(repaired.trail.some((event) => event.kind === "human-confirm"), false);
  assert.equal(repaired.status, "paused");
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
    assert.equal(filesContaining(home, SECRET).length, 0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a headed-off replay of both login paths leaves the secret out of the library", async () => {
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
    assert.equal(filesContaining(home, SECRET).length, 0);
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

test("a person signs in on the fixture after the banner, and replay stops at confirm", async () => {
  const previous = { drive: process.env.BAO_DRIVE, cursor: process.env.BAO_HEAL_CURSOR };
  process.env.BAO_DRIVE = "1";
  delete process.env.BAO_HEAL_CURSOR;
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-human-"));
  const app = await startApp({ home, port: 0 });
  try {
    const workflow = freezeWorkflow();
    workflow.startUrl = `http://127.0.0.1:${app.port}/freeze`;
    workflow.steps[0]!.timeoutMs = 20000;
    const base = `http://127.0.0.1:${app.port}`;
    const imported = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflow),
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
    assert.equal(filesContaining(home, SECRET).length, 0);
  } finally {
    await app.close();
    if (previous.drive === undefined) delete process.env.BAO_DRIVE;
    else process.env.BAO_DRIVE = previous.drive;
    if (previous.cursor === undefined) delete process.env.BAO_HEAL_CURSOR;
    else process.env.BAO_HEAL_CURSOR = previous.cursor;
    rmSync(home, { recursive: true, force: true });
  }
});

test("recording a password field stores a secret slot and not the value", async () => {
  const previous = process.env.BAO_DRIVE;
  process.env.BAO_DRIVE = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-auth-record-"));
  const app = await startApp({ home, port: 0 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/login` }),
    });
    await fetch(`${base}/api/sessions/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fill: { selector: "#username", value: "ada" } }),
    });
    await fetch(`${base}/api/sessions/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ click: "#continue" }),
    });
    await fetch(`${base}/api/sessions/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fill: { selector: "#password", value: SECRET } }),
    });
    const stopped = await fetch(`${base}/api/sessions/stop`, { method: "POST" });
    const saved = await stopped.json() as WorkflowV2;
    assert.equal(JSON.stringify(saved).includes(SECRET), false);
    assert.equal(saved.inputs.some((input) => input.type === "secret" && !input.default), true);
    assert.equal(filesContaining(home, SECRET).length, 0);
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
