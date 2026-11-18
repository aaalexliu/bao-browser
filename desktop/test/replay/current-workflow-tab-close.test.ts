import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { runWorkflow } from "../../src/mcp/catalog";
import type { WorkflowStep } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { chromeProfiles } from "../support/chrome-profiles";
import { targetFor, testWorkflow } from "../support/workflow";
import { scaledMs } from "../runtime";

pinTestBrowser();

// Replay takes page pictures, and Linux Chromium never answers Page.captureScreenshot for a background tab.
const replaySkip = process.platform !== "darwin" && "replay pictures of a background tab hang on Linux Chromium";

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><p id=out>not clicked</p>
<script>b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

const target = (id: string, role: string) => targetFor({ surface: "dom", role, id, path: [] });
const FILL: WorkflowStep = { id: "fill", index: 0, action: "type", caption: { text: "Fill name" }, heal: "never", text: { literal: "Ada" }, target: target("q", "textbox"), timeoutMs: 5000 };
const SAVE: WorkflowStep = { id: "save", index: 0, action: "click", caption: { text: "Save" }, heal: "never", target: target("b", "button"),
  check: { kind: "text", match: "clicked, typed: Ada", timeoutMs: 5000 }, timeoutMs: 5000 };
const MISS: WorkflowStep = { id: "miss", index: 0, action: "verify", caption: { text: "Missing" }, heal: "never", check: { kind: "text", match: "never-here", timeoutMs: 200 }, timeoutMs: 500 };
const HOLD: WorkflowStep = { id: "apply", index: 0, action: "handoff", reason: "owner-press", caption: { text: "Confirm before Save" }, target: target("b", "button"),
  check: { kind: "text", match: "never", timeoutMs: 1000 }, timeoutMs: 1000 };

test("a workflow run on the owner's Chrome closes its own tab, and leaves it when Keep window open is on", { skip: replaySkip, timeout: scaledMs(120_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-workflow-tab-close-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(TASK);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const taskUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/task`;
  const chromeDir = path.join(root, "chrome");
  await chromeProfiles(chromeDir);
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: chromeDir, headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  const closedTargets: string[] = [];
  t.mock.method(profileCopy, "chromeProfilesRoot", () => chromeDir);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    const send = cdp.send.bind(cdp);
    cdp.send = ((method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
      if (method === "Browser.close") throw new Error("a workflow run must not quit the owner's Chrome");
      if (method === "Target.closeTarget" && typeof params?.targetId === "string") closedTargets.push(params.targetId);
      return send(method, params, sessionId, timeoutMs);
    }) as CdpSocket["send"];
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: chromeDir, endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const priorSource = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = chromeDir;
  const home = path.join(root, "home");
  const library = new Library(home);
  let seq = 0;
  const workflow = (steps: WorkflowStep[]): string => {
    const id = `tab-close-${++seq}`;
    library.save(testWorkflow({ id, name: "Tab close", startUrl: taskUrl, steps }));
    return id;
  };
  const pages = async () => (await probe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
    .filter((item) => item.type === "page");
  const { targetId: owner } = await probe.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const openedBy = async (run: () => Promise<void>): Promise<string> => {
    const before = new Set((await pages()).map((item) => item.targetId));
    let found = "";
    const watching = (async () => {
      for (const deadline = Date.now() + scaledMs(20_000); !found && Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 20))) {
        found = (await pages()).find((item) => !before.has(item.targetId) && item.url === taskUrl)?.targetId ?? "";
      }
    })();
    await run();
    await watching;
    assert.ok(found, "the run opened one task tab");
    return found;
  };
  const stayed = async (targetId: string): Promise<void> => {
    for (const deadline = Date.now() + scaledMs(1500); Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
      assert.ok((await pages()).some((item) => item.targetId === targetId), "the run's tab must stay open");
    }
    assert.equal(closedTargets.includes(targetId), false);
  };
  const gone = async (targetId: string): Promise<void> => {
    for (const deadline = Date.now() + scaledMs(3000); Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
      if (!(await pages()).some((item) => item.targetId === targetId)) {
        assert.equal(closedTargets.includes(targetId), true, "release closes the run's own tab");
        return;
      }
    }
    assert.fail("the run's tab was still open");
  };

  let resume: string | undefined;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    library.updateSettings({ keepAgentBrowserOpen: true });
    await stayed(await openedBy(async () => {
      const done = await runWorkflow(library, { id: workflow([FILL, SAVE]), browser: "current" });
      assert.equal(done.outcome, "ok", done.reason);
    }));
    await stayed(await openedBy(async () => {
      const failed = await runWorkflow(library, { id: workflow([MISS]), browser: "current" });
      assert.equal(failed.outcome, "failed", failed.reason);
    }));
    const heldTab = await openedBy(async () => {
      const held = await runWorkflow(library, { id: workflow([FILL, SAVE, HOLD]), browser: "current" });
      resume = held.resume;
      assert.equal(held.outcome, "needs_human", held.reason);
    });
    await runWorkflow(library, { resume, cancel: true });
    resume = undefined;
    await stayed(heldTab);

    library.updateSettings({ keepAgentBrowserOpen: false });
    await gone(await openedBy(async () => {
      const done = await runWorkflow(library, { id: workflow([FILL, SAVE]), browser: "current" });
      assert.equal(done.outcome, "ok", done.reason);
    }));
    const cancelled = await openedBy(async () => {
      const held = await runWorkflow(library, { id: workflow([FILL, SAVE, HOLD]), browser: "current" });
      resume = held.resume;
      assert.equal(held.outcome, "needs_human", held.reason);
    });
    await runWorkflow(library, { resume, cancel: true });
    resume = undefined;
    await gone(cancelled);

    app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: chromeDir });
    const replay = async (id: string) => {
      const response = await fetch(`http://127.0.0.1:${app!.port}/api/replay`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, browser: "current", args: {} }), signal: AbortSignal.timeout(30_000),
      });
      return response.json() as Promise<{ status?: string; error?: string }>;
    };
    app.library.updateSettings({ keepAgentBrowserOpen: true });
    await stayed(await openedBy(async () => {
      const result = await replay(workflow([FILL, SAVE]));
      assert.equal(result.status, "passed", result.error);
    }));
    app.library.updateSettings({ keepAgentBrowserOpen: false });
    await gone(await openedBy(async () => {
      const result = await replay(workflow([FILL, SAVE]));
      assert.equal(result.status, "passed", result.error);
    }));

    assert.ok((await pages()).some((item) => item.targetId === owner), "the owner's tab stays");
    assert.equal(closedTargets.includes(owner), false, "release never closes the owner's tab");
  } finally {
    if (resume) await runWorkflow(library, { resume, cancel: true }).catch(() => undefined);
    await app?.close();
    if (priorSource === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
    else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = priorSource;
    probe.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
