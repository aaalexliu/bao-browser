import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { holdDir, joinOrStartHold } from "../../src/cdp-live/chrome-hold";
import { Takeover } from "../../src/cdp-live/takeover";
import { AdmittedTakeover } from "../../src/cdp-live/takeover-hold";
import { pageMap } from "../../src/app/step-record-view";
import { readPage } from "../../src/engines/step-page";
import { launchOwnedChromeEndpoint } from "../../src/launch";
import { testChromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { replay } from "../../src/v1/replay";
import type { Identity, WorkflowStep } from "../../src/v1/schema";
import { OVERLAY_HOST_ATTRIBUTE } from "../../../shared/takeover-overlay";
import { targetFor, testWorkflow } from "../support/workflow";

const exec = promisify(execFile);
const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  return upDistance <= diagonal ? up : upLeft;
}

/** One pixel from an 8-bit RGB or RGBA PNG. Chrome's capture is one of those. */
function pngPixel(png: Buffer, x: number, y: number): [number, number, number] {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const color = png[25];
  if (png[24] !== 8 || (color !== 2 && color !== 6) || y < 0 || y >= height || x < 0 || x >= width) throw new Error(`unexpected png ${color} at ${x},${y}`);
  const channels = color === 6 ? 4 : 3;
  let offset = 8;
  const idats: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") idats.push(png.subarray(offset + 8, offset + 8 + length));
    if (kind === "IEND") break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const start = row * (stride + 1);
    const filter = raw[start];
    const out = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      const value = raw[start + 1 + i];
      if (filter === 0) out[i] = value;
      else if (filter === 1) out[i] = (value + left) & 255;
      else if (filter === 2) out[i] = (value + up) & 255;
      else if (filter === 3) out[i] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) out[i] = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error(`unexpected png filter ${filter}`);
    }
    previous = out;
  }
  const at = x * channels;
  return [previous[at], previous[at + 1], previous[at + 2]];
}

async function page(): Promise<{ dir: string; cdp: CdpSocket; targetId: string; sessionId: string; port: number; browserPath: string; pid: number | undefined; portFile: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-takeover-"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: dir, headless: true, keychain: "mock" });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const targetId = targetInfos.find((target) => target.type === "page")?.targetId;
  if (!targetId) throw new Error("headless Chrome opened no page");
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: "data:text/html,<title>Fixture</title><body style='margin:0;background:%23fff'></body>" }, sessionId);
  await cdp.send("Runtime.evaluate", {
    expression: `document.body.innerHTML = '<button id="hit" style="position:fixed;left:40px;top:80px;width:80px;height:40px">Hit</button>';
      window.hits = 0;
      document.getElementById("hit").addEventListener("click", () => { window.hits += 1; });`,
    returnByValue: true,
  }, sessionId);
  return {
    dir, cdp, targetId, sessionId, port: endpoint.port, browserPath: endpoint.browserPath, pid: chrome.pid, portFile: chrome.portFile,
    close: async () => {
      cdp.close();
      await chrome.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function hits(cdp: CdpSocket, sessionId: string): Promise<number> {
  const read = await cdp.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "window.hits", returnByValue: true }, sessionId);
  return read.result.value;
}

async function click(cdp: CdpSocket, sessionId: string): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 80, y: 100, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 80, y: 100, button: "left", clickCount: 1 }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

test("the shield blocks a click, and the watchdog gives the page back", async () => {
  const open = await page();
  const takeover = new Takeover({ watchdogMs: 400, quiet: true });
  try {
    await takeover.attachPort(open.portFile, open.targetId);
    await click(open.cdp, open.sessionId);
    assert.equal(await hits(open.cdp, open.sessionId), 0);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await click(open.cdp, open.sessionId);
    assert.equal(await hits(open.cdp, open.sessionId), 1);
  } finally {
    await takeover.dispose();
    await open.close();
  }
});

test("an acting click lands on the page under the notch", async () => {
  const open = await page();
  const takeover = new Takeover({ quiet: true });
  try {
    await open.cdp.send("Runtime.evaluate", {
      expression: "document.body.insertAdjacentHTML('beforeend', '<div id=\"bar\" style=\"position:fixed;left:0;top:0;width:100%;height:36px\">Store</div>');",
      returnByValue: true,
    }, open.sessionId);
    await takeover.attachPort(open.portFile, open.targetId);
    const hit = async () => {
      const read = await open.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: `(() => {
          const bar = document.getElementById("bar");
          const rect = bar.getBoundingClientRect();
          const node = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return node === bar ? "page" : (node && node.tagName || "none").toLowerCase();
        })()`,
        returnByValue: true,
      }, open.sessionId);
      return read.result.value;
    };
    assert.notEqual(await hit(), "page", "the notch covers the top-center point until the agent acts");
    await takeover.bracket(async () => {
      assert.equal(await hit(), "page", "the agent's click point must be the page, not the overlay host");
    });
    assert.notEqual(await hit(), "page", "the notch takes owner clicks again after the action");
  } finally {
    await takeover.dispose();
    await open.close();
  }
});

test("the overlay is absent from the snapshot and from a step picture", async () => {
  const open = await page();
  const takeover = new Takeover({ quiet: true });
  try {
    await takeover.attachPort(open.portFile, open.targetId);
    await takeover.activityLine("Reading the page");
    await open.cdp.send("Accessibility.enable", {}, open.sessionId);
    const tree = await open.cdp.send<{ nodes: { name?: string; value?: string }[] }>("Accessibility.getFullAXTree", {}, open.sessionId);
    const names = JSON.stringify(tree.nodes.map((node) => [node.name, node.value]));
    assert.equal(names.includes("Click to take control"), false);
    assert.equal(names.includes("You're in control"), false);
    assert.equal(names.includes("Reading the page"), false);
    if (binary) {
      const snap = await exec(binary, ["--cdp", String(open.port), "snapshot"], { encoding: "utf8", timeout: 20_000, env: process.env });
      assert.equal(snap.stdout.includes("Click to take control"), false);
      assert.equal(snap.stdout.includes("You're in control"), false);
      assert.equal(snap.stdout.includes("Reading the page"), false);
    }
    const metrics = await open.cdp.send<{ cssLayoutViewport: { clientWidth: number } }>("Page.getLayoutMetrics", {}, open.sessionId);
    const x = Math.floor(metrics.cssLayoutViewport.clientWidth / 2);
    const shown = await open.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, open.sessionId);
    const shownPng = Buffer.from(shown.data, "base64");
    const size = pngSize(shownPng);
    assert.ok(x > 8 && x < size.width - 8);
    const dark = pngPixel(shownPng, x, 8);
    assert.ok(dark[0] < 40 && dark[1] < 40 && dark[2] < 40, `notch pixel ${dark.join(",")}`);
    await takeover.hideForShot(async () => {
      const hidden = await open.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, open.sessionId);
      const light = pngPixel(Buffer.from(hidden.data, "base64"), x, 8);
      assert.ok(light[0] > 200 && light[1] > 200 && light[2] > 200, `hidden pixel ${light.join(",")}`);
    });
  } finally {
    await takeover.dispose();
    await open.close();
  }
});

test("the receipt's page map lists the site's buttons and leaves out the overlay's", async () => {
  const open = await page();
  const takeover = new Takeover({ quiet: true });
  try {
    await open.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const shop = document.createElement("div");
        shop.attachShadow({ mode: "closed" }).innerHTML = "<button>Buy now</button>";
        document.body.append(shop);
      })()`,
      returnByValue: true,
    }, open.sessionId);
    await takeover.attachPort(open.portFile, open.targetId);
    await takeover.showAsk("Sign in, then click Done");
    const read = await readPage(<T>(method: string, params?: Record<string, unknown>) => open.cdp.send<T>(method, params ?? {}, open.sessionId), () => false, false);
    const buttons = pageMap(read.state.dom, "before").buttons.map((button) => button.text);
    assert.deepEqual(buttons, ["Hit", "Buy now"]);
  } finally {
    await takeover.dispose();
    await open.close();
  }
});

/** Replays one handoff step on a page that answers the overlay's removal late. Reports whether the pill showed and whether each step picture caught it. */
async function replayOnBusyPage(html: string, step: WorkflowStep): Promise<{ status: string; pillSeen: boolean; pictured: boolean[] }> {
  const shotDir = mkdtempSync(path.join(tmpdir(), "bao-handoff-shot-"));
  const browser = await testChromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    // A busy page answers the overlay's removal late.
    const context = page.context();
    const newSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const client = await newSession(target);
      const send = client.send.bind(client) as (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      Object.assign(client, {
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("dispose")) await new Promise((resolve) => setTimeout(resolve, 300));
          return send(method, params);
        },
      });
      return client;
    };
    const driver = new BrowserDriver(page);
    const overlayShown = () => page.evaluate((selector) => document.querySelector(selector) !== null, `[${OVERLAY_HOST_ATTRIBUTE}]`);
    let pillSeen = false;
    const tree = driver.tree.bind(driver);
    driver.tree = async () => {
      pillSeen ||= await overlayShown();
      return tree();
    };
    const pictured: boolean[] = [];
    const shot = driver.shot.bind(driver);
    driver.shot = async (target) => {
      pictured.push(await overlayShown());
      return shot(target);
    };
    const run = await replay(testWorkflow({ driver: "playwright", steps: [step] }), {}, driver, { settings: { heal: "never" }, shotDir });
    return { status: run.status, pillSeen, pictured };
  } finally {
    await browser.close();
    rmSync(shotDir, { recursive: true, force: true });
  }
}

const save = { surface: "dom", role: "button", name: "Save", path: [] } as Identity;

test("a live handoff that times out takes its failure picture after the control pill is gone", async () => {
  const run = await replayOnBusyPage("<button>Save</button>", {
    id: "press", index: 0, timeoutMs: 400, caption: { text: "you press Save" }, action: "handoff", reason: "owner-press",
    target: targetFor(save), check: { kind: "text", match: "Applied", timeoutMs: 400 },
  });
  assert.equal(run.status, "failed");
  assert.equal(run.pillSeen, true, "the control pill showed while Bao waited for the owner");
  assert.equal(run.pictured.at(-1), false, "the failure picture waits until the pill is gone");
});

test("a live handoff the owner finishes takes its step picture after the control pill is gone", async () => {
  // The page writes the awaited text in pieces, so the script's own source does not match the check.
  const run = await replayOnBusyPage("<button>Save</button><p id=m></p><script>setTimeout(() => { m.textContent = ['App', 'lied'].join(''); }, 300)</script>", {
    id: "press", index: 0, timeoutMs: 3000, caption: { text: "you press Save" }, action: "handoff", reason: "owner-press",
    target: targetFor(save), check: { kind: "text", match: "Applied", timeoutMs: 3000 },
  });
  assert.equal(run.status, "passed");
  assert.equal(run.pillSeen, true, "the control pill showed while Bao waited for the owner");
  assert.equal(run.pictured.at(-1), false, "the step picture waits until the pill is gone");
});

test("a sign-in wait the owner finishes takes its step picture after the control pill is gone", async () => {
  const run = await replayOnBusyPage("<p id=m>Sign in</p><script>setTimeout(() => { m.textContent = ['Welcome', 'back'].join(' '); }, 300)</script>", {
    id: "login", index: 0, timeoutMs: 3000, caption: { text: "you sign in" }, action: "handoff", reason: "sign-in",
    check: { kind: "text", match: "Welcome back", timeoutMs: 3000 },
  });
  assert.equal(run.status, "passed");
  assert.equal(run.pillSeen, true, "the control pill showed while Bao waited for the owner");
  assert.equal(run.pictured.at(-1), false, "the step picture waits until the pill is gone");
});

test("Running Chrome draws the overlay through the hold's counted session", { timeout: 40_000 }, async () => {
  const open = await page();
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-takeover-hold-"));
  const root = await realpath(scratch);
  const previous = process.env.BAO_CHROME_HOLD_FIXTURE;
  let holderPid = 0;
  let joined: Awaited<ReturnType<typeof joinOrStartHold>> | undefined;
  let remote: AdmittedTakeover | undefined;
  try {
    if (!open.pid || !open.browserPath) throw new Error("headless Chrome published no debugging endpoint");
    process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
      port: open.port, browserPath: open.browserPath, chromePid: open.pid, executable: "Google Chrome for Testing",
    });
    joined = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
    const record = JSON.parse(readFileSync(path.join(holdDir(root), "hold.json"), "utf8")) as { holderPid: number };
    holderPid = record.holderPid;
    const socket = joined.admitted;
    if (!socket) throw new Error("the hold did not count this session");
    remote = new AdmittedTakeover(socket);
    await remote.attach(open.targetId);
    await click(open.cdp, open.sessionId);
    assert.equal(await hits(open.cdp, open.sessionId), 0);
  } finally {
    await remote?.dispose().catch(() => undefined);
    joined?.detach();
    await open.close();
    if (holderPid) {
      try { process.kill(holderPid, "SIGKILL"); } catch { /* the hold already exited */ }
    }
    rmSync(scratch, { recursive: true, force: true });
    try { rmSync(holdDir(root), { recursive: true, force: true }); } catch { /* the hold dir is already gone */ }
    if (previous === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previous;
  }
});
