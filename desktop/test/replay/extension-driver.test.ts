import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hostAccessPanel, runDriverField, runHealField } from "../../src/app/views";
import { FrameDecoder, MAX_FROM_CHROME_BYTES, encodeFrame } from "../../src/extension/frames";
import { clampGesture, fillPlan, gestureQueue } from "../../src/extension/gestures";
import { acceptAuth, originArg } from "../../src/extension/native-host";
import { hostScriptPath, startExtensionLink } from "../../src/extension/link";
import { EXTENSION_ID, EXTENSION_KEY, extensionOrigin, workflowDriver } from "../../src/extension/protocol";
import {
  ALL_SITE_ORIGINS,
  grantedCovers,
  hostAccessFromOrigins,
  hostAccessLabel,
  hostGrantMessage,
  hostGrantPlan,
  isHostGrantMessage,
  specificHost,
  specificOrigins,
} from "../../../extension/src/host-grant";
import { diffSignals, hashCookieHeader, hashValue } from "../../src/extension/signals";
import { validateWorkflow } from "../../src/v1/schema";
import { createHash } from "node:crypto";

test("driver defaults to playwright and only extension selects the extension", () => {
  assert.equal(workflowDriver({}), "playwright");
  assert.equal(workflowDriver({ driver: "playwright" }), "playwright");
  assert.equal(workflowDriver({ driver: "extension" }), "extension");
  assert.equal(workflowDriver({ driver: "cdp" }), "playwright");
});

test("workflow validation accepts the extension driver and rejects a third one", () => {
  const doc = testWorkflow({ id: "wf-ext", name: "Ext" });
  assert.deepEqual(validateWorkflow(doc), []);
  assert.deepEqual(validateWorkflow({ ...doc, driver: "extension" }), []);
  assert.deepEqual(validateWorkflow({ ...doc, driver: "playwright" }), []);
  assert.ok(validateWorkflow({ ...doc, driver: "cdp" as "extension" }).includes("driver"));
});

test("native frames round-trip, refuse a message to Chrome over 1MB, and take a larger one from Chrome", () => {
  const decoder = new FrameDecoder();
  const encoded = Buffer.concat([encodeFrame({ type: "hello", n: 1 }), encodeFrame({ type: "ping" })]);
  const split = decoder.push(encoded.subarray(0, 3));
  assert.equal(split.length, 0);
  const frames = decoder.push(encoded.subarray(3));
  assert.deepEqual(frames, [{ type: "hello", n: 1 }, { type: "ping" }]);
  const picture = { blob: "x".repeat(1024 * 1024) };
  assert.throws(() => encodeFrame(picture), /exceeds 1048576 bytes/);
  assert.throws(() => new FrameDecoder().push(encodeFrame(picture, MAX_FROM_CHROME_BYTES)), /exceeds 1048576 bytes/);
  assert.deepEqual(new FrameDecoder(MAX_FROM_CHROME_BYTES).push(encodeFrame(picture, MAX_FROM_CHROME_BYTES)), [picture]);
});

test("gesture queue follows consuming steps and keeps the recording's gaps", () => {
  const byEvent = new Map([
    ["click-1", { dwellMs: 400, pointer: [{ dt: 120, x: 8, y: 9 }], keyGaps: [] }],
    ["type-1", { dwellMs: 80, pointer: [], keyGaps: [90, 110] }],
    ["order", { dwellMs: 999, pointer: [], keyGaps: [] }],
  ]);
  const queue = gestureQueue(
    [{ action: "click" }, { action: "extract" }, { action: "type" }, { action: "confirm" }],
    [
      [{ id: "click-1", op: "click" }],
      [{ id: "extract-1", op: "extract" }],
      [{ id: "type-1", op: "type" }],
      [{ id: "order", op: "click" }],
    ],
    byEvent,
  );
  assert.equal(queue.length, 2);
  assert.equal(queue[0]?.dwellMs, 400);
  assert.equal(queue[1]?.keyGaps[1], 110);
  assert.deepEqual(fillPlan("ab", []), { mode: "once", gaps: [] });
  assert.equal(fillPlan("ab", [90]).mode, "cadence");
  const capped = clampGesture({ dwellMs: 5000, pointer: [{ dt: 4000, x: 1, y: 2 }], keyGaps: [3000] }, 1000);
  assert.equal(capped.dwellMs, 1000);
  assert.equal(capped.pointer[0]?.dt, 1000);
  assert.equal(capped.keyGaps[0], 1000);
  assert.equal(clampGesture({ dwellMs: 40, pointer: [], keyGaps: [] }, undefined).maxMs, undefined);
});

test("signal diff names the cause and leaves spoofing off the fix", () => {
  const rows = diffSignals([
    { name: "tls.ja3", human: "a", extension: "a", playwright: "b" },
    { name: "navigator.webdriver", human: "false", extension: "false", playwright: "true" },
    { name: "event.isTrusted", human: "true", extension: "false", playwright: "true" },
    { name: "header.user-agent", human: "Chrome", extension: "Chrome", playwright: "Chrome" },
  ]);
  assert.equal(rows.length, 3);
  assert.match(rows[0]?.cause || "", /ClientHello/);
  assert.match(rows[0]?.fix || "", /Do not rewrite/);
  assert.match(rows[1]?.cause || "", /enable-automation/);
  assert.match(rows[2]?.cause || "", /untrusted/);
  assert.match(rows[2]?.fix || "", /trusted/);
  const hashed = hashCookieHeader("visid_incap=secret-cookie; incap_ses=other");
  assert.equal(hashed.includes("secret-cookie"), false);
  assert.equal(hashed.includes(hashValue("secret-cookie")), true);
});

test("the host rejects a bad token and a foreign extension origin", () => {
  assert.equal(acceptAuth({ type: "auth", token: "nope", extensionId: EXTENSION_ID }, "yes", EXTENSION_ID), false);
  assert.equal(acceptAuth({ type: "auth", token: "yes", extensionId: EXTENSION_ID }, "yes", EXTENSION_ID), true);
  assert.equal(acceptAuth({ type: "hello" }, "yes", EXTENSION_ID), false);
  assert.deepEqual(originArg(["--socket", "/tmp/s"]), { ok: true });
  assert.equal(originArg([extensionOrigin()]).ok, true);
  assert.equal(originArg(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]).ok, false);
});

test("the unpacked extension id is the Chrome hash of the public key", () => {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "extension/manifest.json"), "utf8")) as {
    key: string;
    host_permissions?: string[];
    content_scripts?: unknown;
    optional_host_permissions?: string[];
  };
  assert.equal(manifest.key, EXTENSION_KEY);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  const der = Buffer.from(EXTENSION_KEY, "base64");
  const hash = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i] ?? 0;
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15));
  }
  assert.equal(id, EXTENSION_ID);
});

test("a missing host grant is needs-you copy for one origin", () => {
  const pattern = "https://books.toscrape.com/*";
  const timedOut = hostGrantMessage(pattern, "timeout");
  const denied = hostGrantMessage(pattern, "denied");
  assert.equal(isHostGrantMessage(timedOut), true);
  assert.equal(isHostGrantMessage(denied), true);
  assert.match(timedOut, /not granted in time/);
  assert.match(denied, /did not grant the site/);
  assert.equal(isHostGrantMessage(`site not allowed: ${pattern}`), false);
  assert.equal(specificHost(pattern), true);
  assert.equal(specificHost("http://127.0.0.1:8080/*"), true);
  assert.equal(specificHost("https://*/*"), false);
  assert.equal(specificHost("http://*/*"), false);
  assert.equal(specificHost("https://*.example.com/*"), false);
  assert.equal(specificHost("<all_urls>"), false);
  assert.match(timedOut, /Allow all sites/);
  assert.match(timedOut, /Only this site/);
  assert.equal(isHostGrantMessage("Allow Bao on https://books.toscrape.com/*. Click Allow sites. The site was not granted in time."), true);
});

test("an all-sites grant skips prompts and revoke returns to per-site needs_human", () => {
  const books = "https://books.toscrape.com/*";
  const quotes = "https://quotes.toscrape.com/*";
  const all = [...ALL_SITE_ORIGINS];
  assert.deepEqual(all, ["http://*/*", "https://*/*"]);
  assert.equal(hostGrantPlan(books, all, 90_000).action, "skip");
  assert.equal(hostGrantPlan(quotes, all, 0).action, "skip");
  assert.equal(grantedCovers(quotes, all), true);
  assert.equal(hostAccessFromOrigins(all), "all");
  assert.equal(hostAccessFromOrigins(["https://*/*"]), "all");
  assert.equal(hostAccessFromOrigins(["http://*/*", books]), "all");
  assert.equal(hostAccessLabel("all"), "all sites");

  const revoked: string[] = [];
  assert.equal(hostAccessFromOrigins(revoked), "none");
  assert.equal(hostAccessLabel("none"), "none");
  assert.equal(hostGrantPlan(quotes, revoked, 4_000).action, "prompt");
  const timedOut = hostGrantPlan(quotes, revoked, 0);
  assert.equal(timedOut.action, "needs_human");
  if (timedOut.action === "needs_human") {
    assert.match(timedOut.message, /quotes\.toscrape\.com/);
    assert.match(timedOut.message, /not granted in time/);
  }

  assert.equal(hostAccessFromOrigins([books]), "site");
  assert.equal(hostAccessLabel("site"), "per site");
  assert.equal(hostGrantPlan(books, [books], 4_000).action, "skip");
  assert.equal(hostGrantPlan(quotes, [books], 4_000).action, "prompt");
  assert.equal(specificOrigins(`${quotes},https://*/*`).join(","), quotes);
  assert.equal(specificOrigins("http://*/*").length, 0);

  const background = readFileSync(path.join(process.cwd(), "extension/src/background.ts"), "utf8");
  const allow = readFileSync(path.join(process.cwd(), "extension/src/allow.ts"), "utf8");
  const page = readFileSync(path.join(process.cwd(), "extension/src/allow.html"), "utf8");
  assert.match(background, /chrome\.permissions\.remove/);
  assert.match(background, /Matches stay on this origin/);
  assert.equal(background.includes("<all_urls>"), true);
  assert.equal(background.includes('urls: ["<all_urls>"]'), false);
  assert.match(allow, /chrome\.permissions\.request\(\{ origins \}\)/);
  assert.match(allow, /ALL_SITE_ORIGINS/);
  assert.match(page, /Allow all sites/);
  assert.match(page, /Only this site/);
  assert.match(page, /read and act on any site in this Chrome profile/);
  assert.match(page, /while a run or a recording is active/);
  assert.match(page, /revoke it in Settings/);

  for (const access of ["all", "site", "none"] as const) {
    const html = hostAccessPanel(access);
    assert.match(html, new RegExp(`Site access: ${hostAccessLabel(access)}`));
    assert.match(html, /id="revoke-hosts"/);
    assert.match(html, /id="host-access-status"/);
  }
  assert.match(hostAccessPanel("all"), /data-host-access="all"/);
  assert.match(hostAccessPanel("none"), /disabled/);
  assert.equal(/disabled/.test(hostAccessPanel("all")), false);
  assert.match(hostAccessPanel(undefined), /Site access: none/);
});

test("the run form shows Playwright unless the workflow asks for the extension", () => {
  const playwright = runDriverField(undefined);
  assert.match(playwright, /data-testid="run-driver"/);
  assert.match(playwright, /Playwright - selected Chrome/);
  assert.match(playwright, /value="playwright"[^>]*selected/);
  const extension = runDriverField("extension");
  assert.match(extension, /value="extension"[^>]*selected/);
  assert.doesNotMatch(playwright, /Retired live driver/);
  assert.doesNotMatch(extension, /Retired live driver/);
});

test("the run form keeps the heal choice", () => {
  const field = runHealField("approve", "auto");
  assert.match(field, /<select id="wf-heal" data-testid="run-heal">/);
  assert.match(field, /Use the global setting \(Heal it\)/);
  assert.match(field, /value="auto"[^>]*>Heal it/);
  assert.match(field, /value="approve" selected>Ask me/);
  assert.match(runHealField("", "approve"), /Use the global setting \(Ask me\)/);
  assert.doesNotMatch(field, /retired live driver/);
});

test("the bridge accepts the token file and drops a bad token", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-ext-link-"));
  const link = await startExtensionLink({
    home,
    configHome: home,
    hostScript: hostScriptPath(),
  });
  try {
    const token = readFileSync(path.join(home, "extension-host", "token"), "utf8").trim();
    const bad = connect(link.socketPath);
    const closed = new Promise((resolve) => bad.on("close", resolve));
    bad.write(encodeFrame({ type: "auth", token: "wrong", extensionId: EXTENSION_ID }));
    await closed;
    const good = connect(link.socketPath);
    const decoder = new FrameDecoder();
    const authed = new Promise<unknown>((resolve, reject) => {
      good.on("data", (chunk) => {
        const frames = decoder.push(chunk);
        if (frames[0]) resolve(frames[0]);
      });
      good.on("error", reject);
    });
    good.write(encodeFrame({ type: "auth", token, extensionId: EXTENSION_ID }));
    assert.deepEqual(await authed, { type: "auth-ok" });
    const serial = link.helloSerial;
    good.write(encodeFrame({ type: "hello", extensionId: EXTENSION_ID, version: "0.1.0", resumed: false }));
    const hello = await link.waitForHello(serial, 2000);
    assert.equal(hello.extensionId, EXTENSION_ID);
    assert.equal(link.connected(), true);
    good.end();
  } finally {
    await link.close();
  }
});
