// Product pages never show this machine's listen address.
// Replay still opens the real URL. The capture bar has no Dock icon.
// The bundled browser is named Bao without re-signing the helper.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { emptyLogin, loginsScreen, syncPanel } from "../../src/app/logins-view";
import {
  actBar,
  libraryTable,
  networkPane,
  notices,
  runViewer,
  siteTrustPanel,
  teachHome,
  workflowDetail,
} from "../../src/app/views";
import { guideHtml } from "../../src/v1/guide";
import { makeAsk } from "../../src/v1/human-ask";
import type { WorkflowV2 } from "../../src/v1/schema";
import { controlKey, expandControlKey, loopbackPlace, visibleCopy } from "../../src/v1/visible-copy";

const LISTEN = "http://127.0.0.1:4787/fixture";

function assertNoListen(html: string, where: string): void {
  assert.equal(html.includes("127.0.0.1"), false, where);
  assert.equal(html.includes("localhost"), false, where);
  assert.equal(html.includes("[::1]"), false, where);
}

test("loopback copy reads as Fixture, a path, or the fixture", () => {
  assert.equal(visibleCopy(`Open ${LISTEN}`), "Fixture");
  assert.equal(visibleCopy("Open http://127.0.0.1:4787/"), "Fixture");
  assert.equal(visibleCopy("Open http://127.0.0.1:4787/fixture/room"), "Fixture");
  assert.equal(visibleCopy("Open http://127.0.0.1:9/secure"), "/secure");
  assert.equal(visibleCopy("Open http://localhost:4787/account"), "/account");
  assert.equal(visibleCopy("Sign in to 127.0.0.1 in the Bao window"), "Sign in to the fixture in the Bao window");
  assert.equal(visibleCopy("Opened http://127.0.0.1:4787/fixture then clicked"), "Opened Fixture then clicked");
  assert.equal(visibleCopy("Open https://example.com/fixture"), "Open https://example.com/fixture");
  assert.equal(loopbackPlace("http://[::1]:4787/fixture"), "Fixture");
  assert.equal(controlKey("http://127.0.0.1:4787"), "fixture4:4787");
  assert.equal(expandControlKey("fixture4:4787"), "http://127.0.0.1:4787");
  assert.equal(expandControlKey("fixture4:80"), "http://127.0.0.1");
  assert.equal(expandControlKey("fixturel:9"), "http://localhost:9");
  assert.equal(expandControlKey("https://example.com"), "https://example.com");
  assert.equal(controlKey("https://example.com").includes("127.0.0.1"), false);
});

test("rendered product pages never contain the listen address", () => {
  const login = emptyLogin();
  login.saved = [{
    origin: "http://127.0.0.1:4787",
    probeUrl: LISTEN,
    signedInSelector: "",
    signedInText: "",
    botCookies: "skip",
    origins: [],
  }];
  const ask = makeAsk({
    kind: "login",
    workflowId: "wf",
    workflowName: "Fixture",
    stepId: "login",
    stepIndex: 1,
    stepCount: 2,
    label: "Sign in",
    site: "127.0.0.1:4787",
    timeoutMs: 1000,
    now: 1_000,
  });
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Fixture",
    startUrl: LISTEN,
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "open",
      index: 0,
      action: "navigate",
      label: `Open ${LISTEN}`,
      surface: "dom",
      timeoutMs: 8000,
    }, {
      id: "secure",
      index: 1,
      action: "navigate",
      label: "Open http://localhost:4787/secure",
      surface: "dom",
      timeoutMs: 8000,
    }],
  };
  const pages: [string, string][] = [
    ["library", libraryTable([{
      id: "wf",
      name: "Fixture",
      steps: 2,
      firstStep: { action: "navigate", label: `Open ${LISTEN}` },
    }], [])],
    ["detail", workflowDetail({
      id: "wf",
      name: "Fixture",
      steps: doc.steps,
    })],
    ["run", runViewer({
      id: "run-1",
      workflowId: "wf",
      status: "paused",
      steps: [{ id: "open", status: "paused", label: `Open ${LISTEN}` }],
      envelope: {
        status: "needs_signin",
        ask: "Sign in to 127.0.0.1 in the Bao window",
        reason: "Sign in to localhost in the Bao window",
      },
    }, { name: "Fixture", steps: [{ id: "open", label: `Open ${LISTEN}` }] })],
    ["act", actBar({ activeAsk: ask }, 1_000)],
    ["teach", teachHome([{ id: "wf", name: `Open ${LISTEN}` }])],
    ["network", networkPane([{ stepId: "open", method: "GET", url: LISTEN, status: 200 }], "open")],
    ["logins", loginsScreen(login)],
    ["sync", syncPanel({ server: "https://bao.example", deviceName: "Ada's Mac" })],
    ["trust", siteTrustPanel([{ origin: "http://127.0.0.1:4787", mode: "ask" }])],
    ["notice", notices([{ title: "You need to act", body: `Open ${LISTEN}` }])],
    ["guide", guideHtml(doc, new Map())],
  ];
  for (const [where, html] of pages) assertNoListen(html, where);
  assert.match(pages[0][1], /ph-label">Fixture</);
  assert.match(pages[1][1], /\/secure/);
  assert.match(pages[3][1], /Sign in to the fixture in the Bao window/);
  assert.match(pages[5][1], /Fixture</);
  assert.match(pages[6][1], /<strong>Fixture<\/strong>/);
  assert.match(pages[6][1], /data-recheck="fixture4:4787"/);
  assert.match(pages[7][1], /placeholder="Pairing server"/);
  assert.match(pages[8][1], /data-site-trust="fixture4:4787"/);
  assert.match(pages[8][1], />Fixture/);
  const server = readFileSync(path.join(process.cwd(), "desktop/src/app/server.ts"), "utf8");
  assert.match(server, /function captureStepLabel[\s\S]*visibleCopy\(text\)/);
  assert.equal(visibleCopy(`Open ${LISTEN} — keep the note`), `Open Fixture — keep the note`);
});

test("the capture bar is an accessory and the bundled browser is named Bao", () => {
  const root = path.join(process.cwd(), "desktop/packaging/macos");
  const plist = readFileSync(path.join(root, "CaptureBar-Info.plist"), "utf8");
  const bar = readFileSync(path.join(root, "capture-bar.m"), "utf8");
  const script = readFileSync(path.join(root, "package-app.sh"), "utf8");
  const ui = plist.indexOf("<key>LSUIElement</key>");
  assert.ok(ui > 0);
  assert.match(plist.slice(ui, ui + 40), /<true\/>/);
  assert.match(bar, /NSApplicationActivationPolicyAccessory/);
  assert.equal(bar.includes("NSApplicationActivationPolicyRegular"), false);
  assert.equal(bar.includes("dockTile"), false);
  assert.match(script, /Set :CFBundleName Bao/);
  assert.match(script, /Set :CFBundleDisplayName Bao/);
  assert.match(script, /codesign --force --sign "\$IDENTITY" "\$CHROME"/);
  assert.equal(/codesign[^\n]*--deep/.test(script), false);
  assert.equal(/codesign[^\n]*BaoOSHelper/.test(script), false);
});
