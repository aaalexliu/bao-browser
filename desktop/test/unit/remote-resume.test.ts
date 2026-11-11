import { testWorkflow } from "../support/workflow";
import { stepTitle, type WorkflowV2 } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hasHeldRuns, heldConfirmReady, runWorkflow, withHeldPage } from "../../src/mcp/catalog";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import { Library } from "../../src/v1/store";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";

test("production remote confirms continue locally once and reject non-held order resumes", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-resume-"));
  const library = new Library(home);
  let orders = 0;
  let followups = 0;
  const site = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/followup") {
      followups += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/order") {
      orders += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<body style="padding:80px"><button id="place" onclick="fetch('/order',{method:'POST'}).then(()=>document.getElementById('status').textContent='Placed')">Place order</button><p id="status"></p><button id="finish" onclick="fetch('/followup',{method:'POST'}).then(()=>document.getElementById('done').textContent='Finished')">Finish</button><p id="done"></p>`);
  });
  const directory = new MemoryDirectory();
  directory.addDevice("dev-resume", "user-resume");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "user-resume" }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  async function post(route: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    const placed: WorkflowV2["steps"][number] = {
      id: "place",
      index: 0,
      timeoutMs: 1000,
      caption: { text: "Place order", citation: { text: "Place order", source: "name" } },
      heal: "never",
      action: "click",
      target: {
        locators: [
          { kind: "role", role: "button", name: "Place order" },
          { kind: "text", value: "Place order" },
          { kind: "css", value: "#place" },
          { kind: "xpath", value: "//*[@id=\"place\"]" },
        ],
        hint: { role: "button", surface: "dom", id: "place" },
      },
      check: { kind: "text", match: "Placed", timeoutMs: 3000 },
    };
    const workflow: WorkflowV2 = testWorkflow({
      schema: "bao.workflow/v4", id: "failed-order", name: "Synthetic order", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [placed, {
        id: "missing",
        index: 1,
        timeoutMs: 0,
        caption: { text: "Missing follow-up", citation: { text: "Missing follow-up", source: "name" } },
        heal: "never",
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Missing follow-up" },
            { kind: "text", value: "Missing follow-up" },
            { kind: "css", value: "#missing" },
            { kind: "xpath", value: "//*[@id=\"missing\"]" },
          ],
          hint: { role: "button", surface: "dom", id: "missing" },
        },
      }],
    });
    library.save(workflow);
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Synthetic Mac", deviceId: "dev-resume" });
    const agent = await directory.mintAgent("user-resume", "dev-resume");
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Synthetic" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const first = await tool("run_workflow", { id: workflow.id });
    assert.equal(first.outcome, "failed", JSON.stringify(first));
    assert.equal(orders, 1);
    assert.equal(library.readRun(String(first.runId || first.run_id)).modelCalls, 0);
    const token = String(first.resume || first.resume_token || "");
    assert.ok(token);
    const rejected = await tool("resume_workflow", { resume: token });
    assert.equal(rejected.outcome, "failed");
    assert.match(String(rejected.reason), /run_workflow/);
    assert.equal(orders, 1, "remote resume repeated the completed order");

    const gone = `r_${"a".repeat(32)}`;
    const goneFile = path.join(home, "resumes", `${gone}.json`);
    mkdirSync(path.dirname(goneFile), { recursive: true });
    writeFileSync(goneFile, JSON.stringify({ workflowId: workflow.id, stepId: "missing", publicInputs: {}, kind: "confirm" }));
    const missingBrowser = await tool("resume_workflow", { resume: gone });
    assert.equal(missingBrowser.outcome, "failed");
    assert.match(String(missingBrowser.reason), /browser is gone/);
    assert.equal(existsSync(goneFile), false);
    assert.equal(orders, 1);

    library.save(testWorkflow({ ...workflow, id: "held-order", steps: [placed, {
      id: "confirm",
      index: 1,
      timeoutMs: 5000,
      caption: { text: "Finish on the site" },
      action: "handoff",
      reason: "owner-press",
    }] }));
    const held = await tool("run_workflow", { id: "held-order" });
    assert.equal(held.outcome, "needs_human");
    assert.equal(orders, 2);
    const resumed = await tool("resume_workflow", { resume: held.resume || held.resume_token });
    assert.equal(resumed.outcome, "ok", JSON.stringify(resumed));
    assert.equal(orders, 2, "held resume restarted its completed first step");

    const confirm: WorkflowV2["steps"][number] = {
      id: "owner-order",
      index: 0,
      timeoutMs: 5000,
      caption: { text: "Place order on the site" },
      action: "handoff",
      reason: "owner-press",
      check: { kind: "text", match: "Placed", timeoutMs: 3000 },
    };
    const manualConfirm: WorkflowV2["steps"][number] = {
      id: "owner-order",
      index: 0,
      timeoutMs: 5000,
      caption: { text: "Place order on the site" },
      action: "handoff",
      reason: "owner-press",
    };
    const finish: WorkflowV2["steps"][number] = {
      id: "finish",
      index: 1,
      timeoutMs: 1000,
      caption: { text: "Finish", citation: { text: "Finish", source: "name" } },
      heal: "never",
      action: "click",
      target: {
        locators: [
          { kind: "role", role: "button", name: "Finish" },
          { kind: "text", value: "Finish" },
          { kind: "css", value: "#finish" },
          { kind: "xpath", value: "//*[@id=\"finish\"]" },
        ],
        hint: { role: "button", surface: "dom", id: "finish" },
      },
      check: { kind: "text", match: "Finished", timeoutMs: 3000 },
    };
    library.save(testWorkflow({ ...workflow, id: "auto-order", steps: [confirm, finish] }));
    const automatic = await tool("run_workflow", { id: "auto-order" });
    assert.equal(automatic.outcome, "needs_human");
    assert.equal(remote.view().canDetectCompletion, true);
    assert.equal(remote.view().stepNumber, 1);
    assert.equal(remote.view().stepCount, 2);
    await withHeldPage(String(automatic.resume), async (page) => {
      const events = page as unknown as { listenerCount(event: string): number };
      const counts = [events.listenerCount("console"), events.listenerCount("response")];
      for (let poll = 0; poll < 20; poll += 1) assert.equal(await heldConfirmReady(String(automatic.resume)), false);
      assert.deepEqual([events.listenerCount("console"), events.listenerCount("response")], counts, "confirm polls retained new page listeners");
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(followups, 0, "the run continued before the owner acted");
    await withHeldPage(String(automatic.resume), async (page) => {
      await page.locator("#place").click();
      await page.getByText("Placed", { exact: true }).waitFor();
    });
    await waitFor(() => library.readRun(String(automatic.runId)).status === "passed");
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(orders, 3);
    assert.equal(followups, 1, "the held run did not finish without an agent resume");
    assert.equal(library.readRun(String(automatic.runId)).modelCalls, 0);
    const stale = await tool("resume_workflow", { resume: automatic.resume });
    assert.equal(stale.outcome, "ok", JSON.stringify(stale));
    assert.equal(stale.runId, automatic.runId);
    assert.equal(followups, 1);

    library.save(testWorkflow({ ...workflow, id: "manual-order", steps: [manualConfirm, finish] }));
    const manual = await tool("run_workflow", { id: "manual-order" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(followups, 1, "a confirm without evidence must wait for local Continue");
    remote.continue(String(manual.resume), confirm.id);
    remote.continue(String(manual.resume), confirm.id);
    await waitFor(() => library.readRun(String(manual.runId)).status === "passed");
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(followups, 2, "double local Continue repeated the next step");
    assert.equal((await tool("resume_workflow", { resume: manual.resume })).outcome, "ok");
    assert.equal(followups, 2, "agent acknowledgement repeated the next step");

    library.save(testWorkflow({ ...workflow, id: "changed-postcondition", steps: [
      { ...confirm, check: { kind: "text", match: "Old receipt text", timeoutMs: 1000 } }, finish,
    ] }));
    const changed = await tool("run_workflow", { id: "changed-postcondition" });
    const notReady = await tool("resume_workflow", { resume: changed.resume });
    assert.equal(notReady.outcome, "needs_human", "agent resume must still check the postcondition");
    remote.continue(String(changed.resume), confirm.id);
    await waitFor(() => library.readRun(String(changed.runId)).status === "passed");
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(followups, 3, "owner Continue could not acknowledge a changed postcondition");

    library.save(testWorkflow({ ...workflow, id: "two-confirms", steps: [
      confirm,
      { ...manualConfirm, id: "second-confirm", index: 1 },
      {
        id: "finish",
        index: 2,
        timeoutMs: 1000,
        caption: { text: "Finish", citation: { text: "Finish", source: "name" } },
        heal: "never",
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Finish" },
            { kind: "text", value: "Finish" },
            { kind: "css", value: "#finish" },
            { kind: "xpath", value: "//*[@id=\"finish\"]" },
          ],
          hint: { role: "button", surface: "dom", id: "finish" },
        },
        check: { kind: "text", match: "Finished", timeoutMs: 3000 },
      },
    ] }));
    const two = await tool("run_workflow", { id: "two-confirms" });
    await withHeldPage(String(two.resume), async (page) => {
      await page.locator("#place").click();
      await page.getByText("Placed", { exact: true }).waitFor();
    });
    await waitFor(() => (library.readRun(String(two.runId)).steps as { id: string; status: string }[]).some((step) => step.id === "second-confirm" && step.status === "paused"));
    await waitFor(() => remote.view().phase === "waiting");
    assert.equal(followups, 3, "local Continue skipped a later human step");
    assert.equal(remote.view().stepId, "second-confirm");
    assert.equal(remote.view().stepLabel, stepTitle(confirm));
    assert.equal(remote.view().stepNumber, 2);
    assert.equal(remote.view().stepCount, 3);
    assert.equal(remote.view().canDetectCompletion, false);
    remote.continue(String(two.resume), confirm.id);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(remote.view().stepId, "second-confirm", "stale local Continue completed a later confirm");
    const acknowledged = await tool("resume_workflow", { resume: two.resume });
    assert.equal(acknowledged.outcome, "needs_human", JSON.stringify(acknowledged));
    assert.equal(acknowledged.step, "second-confirm");
    assert.equal(followups, 3, "agent acknowledgement skipped a later human step");
    assert.equal((await tool("resume_workflow", { resume: two.resume })).outcome, "ok");
    await waitFor(() => library.readRun(String(two.runId)).status === "passed");
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(followups, 4);

    library.save(testWorkflow({ ...workflow, id: "two-manual-confirms", steps: [
      manualConfirm,
      { ...manualConfirm, id: "second-confirm", index: 1 },
      {
        id: "finish",
        index: 2,
        timeoutMs: 1000,
        caption: { text: "Finish", citation: { text: "Finish", source: "name" } },
        heal: "never",
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Finish" },
            { kind: "text", value: "Finish" },
            { kind: "css", value: "#finish" },
            { kind: "xpath", value: "//*[@id=\"finish\"]" },
          ],
          hint: { role: "button", surface: "dom", id: "finish" },
        },
        check: { kind: "text", match: "Finished", timeoutMs: 3000 },
      },
    ] }));
    const twoManual = await tool("run_workflow", { id: "two-manual-confirms" });
    remote.continue(String(twoManual.resume), confirm.id);
    await waitFor(() => remote.view().stepId === "second-confirm");
    const manualAcknowledged = await tool("resume_workflow", { resume: twoManual.resume });
    assert.equal(manualAcknowledged.outcome, "needs_human", JSON.stringify(manualAcknowledged));
    assert.equal(manualAcknowledged.step, "second-confirm");
    assert.equal(followups, 4, "agent acknowledgement advanced the second manual confirm");
    remote.continue(String(twoManual.resume), "second-confirm");
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(followups, 5);

    for (const release of ["kill", "expiry"] as const) {
      library.updateSettings({ actTimeoutMs: release === "expiry" ? 3000 : 120 * 60 * 1000 });
      const released = await tool("run_workflow", { id: "two-manual-confirms" });
      remote.continue(String(released.resume), confirm.id);
      await waitFor(() => remote.view().stepId === "second-confirm");
      if (release === "kill") remote.kill();
      await waitFor(() => remote.view().phase === "idle");
      await waitFor(() => !existsSync(path.join(home, "resumes", `${released.resume}.json`)));
      await waitFor(() => library.readRun(String(released.runId)).status === (release === "kill" ? "stopped" : "timed-out"));
      const afterRelease = await tool("resume_workflow", { resume: released.resume });
      assert.equal(afterRelease.outcome, "failed", `${release} returned a cached waiting outcome: ${JSON.stringify(afterRelease)}`);
      assert.match(String(afterRelease.reason), /not held/);
      assert.equal(library.readRun(String(released.runId)).status, release === "kill" ? "stopped" : "timed-out");
      assert.equal(followups, 5, `${release} ran a downstream action`);
    }
    library.updateSettings({ actTimeoutMs: 120 * 60 * 1000 });

    const racing = await tool("run_workflow", { id: "manual-order" });
    const results = await Promise.all([
      runWorkflow(library, { resume: String(racing.resume) }),
      runWorkflow(library, { resume: String(racing.resume) }),
    ]);
    assert.ok(results.every((result) => result.outcome === "ok"));
    assert.equal(followups, 6, "competing resumes repeated the next step");
  } finally {
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});

for (const observationFailure of ["navigation", "unreadable"] as const) {
  test(`live continuation drains a ${observationFailure} observation before replay`, { timeout: 30_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-observer-resume-"));
    const library = new Library(home);
    let finishes = 0;
    let wrongClicks = 0;
    const site = createServer((req, res) => {
      if (req.method === "POST") {
        if (req.url === "/finish") finishes += 1;
        else wrongClicks += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<body><button id="wrong" onclick="fetch('/wrong',{method:'POST'})">Do not click</button><button id="finish" onclick="fetch('/finish',{method:'POST'}).then(()=>document.getElementById('status').textContent='Finished')">Finish</button><p id="status"></p></body>`);
    });
    let token = "";
    let release = () => {};
    let observation: Promise<boolean> | undefined;
    const resumes: Promise<unknown>[] = [];
    try {
      await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
      const address = site.address();
      assert.ok(address && typeof address === "object");
      library.save(testWorkflow({
        schema: "bao.workflow/v4", id: "observer-order", name: "Observer order", createdAt: 1,
        startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [
          {
            id: "confirm",
            index: 0,
            timeoutMs: 5000,
            caption: { text: "Finish on the site" },
            action: "handoff",
            reason: "owner-press",
            check: { kind: "text", match: "Ready", timeoutMs: 1000 },
          },
          {
            id: "finish",
            index: 1,
            timeoutMs: 1000,
            caption: { text: "Finish", citation: { text: "Finish", source: "name" } },
            heal: "never",
            action: "click",
            target: {
              locators: [
                { kind: "role", role: "button", name: "Finish" },
                { kind: "text", value: "Finish" },
                { kind: "css", value: "#finish" },
                { kind: "xpath", value: "//*[@id=\"finish\"]" },
              ],
              hint: { role: "button", surface: "dom", id: "finish" },
            },
            check: { kind: "text", match: "Finished", timeoutMs: 3000 },
          },
        ],
      }));
      const held = await runWorkflow(library, { id: "observer-order" });
      assert.equal(held.outcome, "needs_human");
      token = String(held.resume);
      await withHeldPage(token, async (page) => {
        const evaluate = page.evaluate;
        const waitForLoadState = page.waitForLoadState;
        let unblock!: () => void;
        let retryStarted!: () => void;
        const blocked = new Promise<void>((resolve) => { unblock = resolve; });
        const retry = new Promise<void>((resolve) => { retryStarted = resolve; });
        release = unblock;
        let evaluations = 0;
        page.evaluate = (async (...args: unknown[]) => {
          evaluations += 1;
          if (evaluations === 1) {
            if (observationFailure === "navigation") throw new Error("Execution context was destroyed");
            retryStarted();
            await blocked;
            throw new Error("Page unreadable");
          }
          return Reflect.apply(evaluate, page, args) as ReturnType<typeof evaluate>;
        }) as typeof page.evaluate;
        page.waitForLoadState = async (...args) => {
          if (args[0] === "domcontentloaded") {
            retryStarted();
            await blocked;
            return;
          }
          return Reflect.apply(waitForLoadState, page, args);
        };
        try {
          observation = heldConfirmReady(token);
          const sharedObservation = heldConfirmReady(token);
          const observed = Promise.allSettled([observation, sharedObservation]);
          await retry;
          const first = runWorkflow(library, { resume: token }, undefined, { confirmCompleted: true });
          const second = runWorkflow(library, { resume: token });
          resumes.push(first, second);
          assert.equal(await heldConfirmReady(token), false, "a new poll started while continuation owned the run");
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(evaluations, 1, "replay read page handles before the held observation drained");
          assert.equal(finishes, 0, "replay acted while the held observation could still retry");
          await page.locator("#finish").evaluate((button) => {
            const inserted = document.createElement("button");
            inserted.textContent = "New control";
            inserted.onclick = () => { void fetch("/wrong", { method: "POST" }); };
            button.before(inserted);
          });
          release();
          const observations = await observed;
          assert.ok(observations.every((result) => observationFailure === "navigation"
            ? result.status === "fulfilled" && result.value === false
            : result.status === "rejected"));
          const results = await Promise.all([first, second]);
          assert.ok(results.every((result) => result.outcome === "ok"), JSON.stringify(results));
          assert.equal(results[0]?.runId, held.runId);
          assert.deepEqual(results[0], results[1], "competing resumes did not share the first winner");
          assert.equal(finishes, 1, "competing resumes repeated the downstream action");
          assert.equal(wrongClicks, 0, "the replay clicked a different control");
        } finally {
          release();
          page.evaluate = evaluate;
          page.waitForLoadState = waitForLoadState;
        }
      });
    } finally {
      release();
      await Promise.allSettled([observation, ...resumes]);
      if (token) await runWorkflow(library, { resume: token, cancel: true });
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "held run did not settle");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

test("a later run drops a parked sign-in page and resume together", { timeout: 60_000 }, async () => {
  process.env.BAO_HEADED = "0";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-park-"));
  const library = new Library(home);
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<body><button id=\"signin\">Sign in</button><p id=\"status\">Signed out</p></body>");
  });
  const directory = new MemoryDirectory();
  directory.addDevice("dev-park", "user-park");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "user-park" }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  let token = "";
  async function post(route: string, body: unknown, auth?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    library.save(testWorkflow({
      schema: "bao.workflow/v4", id: "parked-signin", name: "Parked sign-in", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [{
        id: "signin",
        index: 0,
        timeoutMs: 5000,
        caption: { text: "Sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Signed in", timeoutMs: 5000 },
      }],
    }));
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Parked Mac", deviceId: "dev-park" });
    const agent = await directory.mintAgent("user-park", "dev-park");
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Parked" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const parked = await tool("run_workflow", { id: "parked-signin" });
    assert.equal(parked.outcome, "needs_human", JSON.stringify(parked));
    token = String(parked.resume || parked.resume_token || "");
    assert.ok(token);
    await waitFor(() => remote.view().phase === "idle");
    assert.equal(remote.view().resumeToken, undefined, "a sign-in park must not hold the remote slot");
    assert.equal(hasHeldRuns(), true);
    await withHeldPage(token, async (page) => { assert.equal(page.isClosed(), false); });
    const searched = await tool("search_workflows", { query: "Parked" });
    assert.equal(searched.outcome, "ok");
    await withHeldPage(token, async (page) => { assert.equal(page.isClosed(), false); });
    assert.equal(remote.view().phase, "idle");
    const later = await tool("run_workflow", { id: "missing-workflow" });
    assert.equal(later.outcome, "failed", JSON.stringify(later));
    await waitFor(() => remote.view().phase === "idle" && !hasHeldRuns());
    assert.equal(existsSync(path.join(home, "resumes", `${token}.json`)), false);
    await assert.rejects(() => withHeldPage(token, async () => undefined), /resume token/);
    const closed = await tool("resume_workflow", { resume: token });
    assert.equal(closed.outcome, "failed", JSON.stringify(closed));
    assert.match(String(closed.reason), /not held/);
    assert.equal(hasHeldRuns(), false);
    token = "";
  } finally {
    if (token) await runWorkflow(library, { resume: token, cancel: true }).catch(() => undefined);
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});

test("stop during a resumed held run stops the replay and returns", { timeout: 90_000 }, async () => {
  process.env.BAO_HEADED = "0";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const unmetCheckMs = 30_000;
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-stop-"));
  const library = new Library(home);
  let acted = 0;
  const site = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/acted") {
      acted += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<body><button id=\"linger\" onclick=\"fetch('/acted',{method:'POST'}).then(()=>document.getElementById('status').textContent='Clicked')\">Linger</button><p id=\"status\"></p></body>");
  });
  const directory = new MemoryDirectory();
  directory.addDevice("dev-stop", "user-stop");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "user-stop" }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  async function post(route: string, body: unknown, auth?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    library.save(testWorkflow({
      schema: "bao.workflow/v4", id: "stop-held", name: "Stop held", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [
        {
          id: "confirm",
          index: 0,
          timeoutMs: 5000,
          caption: { text: "Confirm on the site" },
          action: "handoff",
          reason: "owner-press",
        },
        {
          id: "linger",
          index: 1,
          timeoutMs: 1000,
          caption: { text: "Linger", citation: { text: "Linger", source: "name" } },
          heal: "never",
          action: "click",
          target: {
            locators: [
              { kind: "role", role: "button", name: "Linger" },
              { kind: "text", value: "Linger" },
              { kind: "css", value: "#linger" },
              { kind: "xpath", value: "//*[@id=\"linger\"]" },
            ],
            hint: { role: "button", surface: "dom", id: "linger" },
          },
          check: { kind: "text", match: "Never happens", timeoutMs: unmetCheckMs },
        },
      ],
    }));
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Stop Mac", deviceId: "dev-stop" });
    const agent = await directory.mintAgent("user-stop", "dev-stop");
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Stop held" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const held = await tool("run_workflow", { id: "stop-held" });
    assert.equal(held.outcome, "needs_human", JSON.stringify(held));
    const token = String(held.resume || held.resume_token || "");
    assert.ok(token);
    await waitFor(() => remote.view().phase === "waiting" && remote.view().stepId === "confirm");
    remote.continue(token, "confirm");
    await waitFor(() => acted === 1);
    const started = Date.now();
    await remote.stop();
    assert.ok(Date.now() - started < unmetCheckMs / 3, "stop waited for the resumed replay to finish its unmet check");
    assert.equal(acted, 1, "the stopped replay repeated the remaining step");
    assert.equal(hasHeldRuns(), false, "shutdown left the held replay in the catalog");
    const stored = library.readRun(String(held.runId || held.run_id));
    assert.equal((stored.failure as { reason?: string } | undefined)?.reason, "cancelled", "the resumed replay finished its unmet check instead of stopping");
  } finally {
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});

async function killDuringHeldReplay(
  label: string,
  follow: (tool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>, token: string) => Promise<Record<string, unknown>>,
): Promise<{ pay: number; result: Record<string, unknown> }> {
  process.env.BAO_HEADED = "0";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), `bao-remote-${label}-`));
  const library = new Library(home);
  let marks = 0;
  let pay = 0;
  const site = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/mark") marks += 1;
    if (req.method === "POST" && req.url === "/pay") pay += 1;
    res.writeHead(req.method === "POST" ? 204 : 200, { "content-type": "text/html; charset=utf-8" });
    if (req.method === "POST") {
      res.end();
      return;
    }
    res.end("<body><button id=\"mark\" onclick=\"fetch('/mark',{method:'POST'})\">Mark</button><button id=\"pay\" onclick=\"fetch('/pay',{method:'POST'}).then(()=>document.getElementById('status').textContent='Paid')\">Pay</button><p id=\"status\"></p></body>");
  });
  const directory = new MemoryDirectory();
  directory.addDevice(`dev-${label}`, `user-${label}`);
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: `user-${label}` }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  async function post(route: string, body: unknown, auth?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  let result: Record<string, unknown> = {};
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    const click = (id: string, name: string, check: string): WorkflowV2["steps"][number] => ({
      id,
      index: id === "mark" ? 1 : 2,
      timeoutMs: 1000,
      caption: { text: name, citation: { text: name, source: "name" } },
      heal: "never",
      action: "click",
      target: {
        locators: [
          { kind: "role", role: "button", name },
          { kind: "text", value: name },
          { kind: "css", value: `#${id}` },
          { kind: "xpath", value: `//*[@id=\"${id}\"]` },
        ],
        hint: { role: "button", surface: "dom", id },
      },
      check: { kind: "text", match: check, timeoutMs: id === "mark" ? 30_000 : 3000 },
    });
    library.save(testWorkflow({
      schema: "bao.workflow/v4", id: `${label}-held`, name: label, createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [
        { id: "confirm", index: 0, timeoutMs: 5000, caption: { text: "Confirm on the site" }, action: "handoff", reason: "owner-press" },
        click("mark", "Mark", "Ready"),
        click("pay", "Pay", "Paid"),
      ],
    }));
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: label, deviceId: `dev-${label}` });
    const agent = await directory.mintAgent(`user-${label}`, `dev-${label}`);
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const content = body.result as { content?: { type: string; text?: string }[] };
      const text = content.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: label })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const held = await tool("run_workflow", { id: `${label}-held` });
    assert.equal(held.outcome, "needs_human", JSON.stringify(held));
    const token = String(held.resume || held.resume_token || "");
    assert.ok(token);
    await waitFor(() => remote.view().phase === "waiting" && remote.view().stepId === "confirm");
    remote.continue(token, "confirm");
    await waitFor(() => marks === 1);
    await withHeldPage(token, async (page) => {
      const evaluate = page.evaluate;
      let release = () => {};
      let waiting = false;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      page.evaluate = (async (...args: unknown[]) => {
        waiting = true;
        await blocked;
        return Reflect.apply(evaluate, page, args) as ReturnType<typeof evaluate>;
      }) as typeof page.evaluate;
      try {
        await waitFor(() => waiting);
        remote.kill();
        await waitFor(() => remote.view().phase === "idle");
        const pending = follow(tool, token);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await page.locator("#status").evaluate((node) => { node.textContent = "Ready"; });
        release();
        page.evaluate = evaluate;
        result = await pending;
      } finally {
        release();
        page.evaluate = evaluate;
      }
    });
  } finally {
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
  return { pay, result };
}

test("a new run after kill does not let the held replay click the next step", { timeout: 90_000 }, async () => {
  const { pay, result } = await killDuringHeldReplay("kill-next", (tool) => tool("run_workflow", { id: "missing-workflow" }));
  assert.equal(pay, 0, "a killed replay clicked its next recorded step");
  assert.equal(result.outcome, "failed", JSON.stringify(result));
  assert.equal(hasHeldRuns(), false, "the killed replay was still in the catalog");
});

test("a retried resume of a killed token does not return the running replay", { timeout: 90_000 }, async () => {
  const { pay, result } = await killDuringHeldReplay("kill-resume", (tool, token) => tool("resume_workflow", { resume: token }));
  assert.equal(pay, 0, "a retried resume returned the running replay and it clicked the next step");
  assert.equal(result.outcome, "failed", JSON.stringify(result));
  assert.match(String(result.reason), /not held|browser is gone/, "a retried resume returned the running replay");
  assert.equal(hasHeldRuns(), false);
});

test("a get_run while parked shows its own label and leaves the parked workflow", { timeout: 90_000 }, async () => {
  process.env.BAO_HEADED = "0";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-label-"));
  const library = new Library(home);
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<body><button id=\"signin\">Sign in</button><p id=\"status\">Signed out</p></body>");
  });
  const directory = new MemoryDirectory();
  directory.addDevice("dev-label", "user-label");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "user-label" }) });
  let stopped = false;
  let releaseResume = () => {};
  let resumeGate = Promise.resolve({} as Record<string, unknown>);
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
    runners: { resume: () => resumeGate },
  });
  const read = library.readRun.bind(library);
  let releaseRead = () => {};
  let readGate = Promise.resolve();
  library.readRun = ((id: string) => readGate.then(() => read(id))) as unknown as typeof library.readRun;
  let token = "";
  async function post(route: string, body: unknown, auth?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    library.save(testWorkflow({
      schema: "bao.workflow/v4", id: "label-park", name: "Label park", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [{
        id: "signin", index: 0, timeoutMs: 5000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in",
        check: { kind: "text", match: "Signed in", timeoutMs: 5000 },
      }],
    }));
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Label Mac", deviceId: "dev-label" });
    const agent = await directory.mintAgent("user-label", "dev-label");
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const content = body.result as { content?: { type: string; text?: string }[] };
      const text = content.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Label park" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const parked = await tool("run_workflow", { id: "label-park" });
    assert.equal(parked.outcome, "needs_human", JSON.stringify(parked));
    token = String(parked.resume || parked.resume_token || "");
    const runId = String(parked.runId || parked.run_id || "");
    assert.ok(token);
    assert.ok(runId);
    await waitFor(() => remote.view().phase === "idle");
    readGate = new Promise((resolve) => { releaseRead = resolve; });
    const looked = tool("get_run", { run_id: runId });
    await waitFor(() => remote.view().phase === "running");
    assert.equal(remote.view().workflowId, runId, "a get_run while parked showed the parked workflow");
    assert.notEqual(remote.view().workflowName, "Label park", "a get_run while parked showed the parked workflow");
    releaseRead();
    const seen = await looked;
    assert.equal(seen.outcome, "ok", JSON.stringify(seen));
    await waitFor(() => remote.view().phase === "idle");
    await withHeldPage(token, async (page) => { assert.equal(page.isClosed(), false); });
    resumeGate = new Promise((resolve) => { releaseResume = () => resolve({ outcome: "needs_human", resume: token }); });
    const resumed = tool("resume_workflow", { resume: token });
    await waitFor(() => remote.view().phase === "running");
    assert.equal(remote.view().workflowId, "label-park", "the parked workflow was replaced by the get_run label");
    assert.equal(remote.view().workflowName, "Label park", "the parked workflow was replaced by the get_run label");
    releaseResume();
    const again = await resumed;
    assert.equal(again.outcome, "needs_human", JSON.stringify(again));
    await waitFor(() => remote.view().phase === "idle");
    readGate = new Promise((resolve) => { releaseRead = resolve; });
    const killed = tool("get_run", { run_id: runId });
    await waitFor(() => remote.view().phase === "running" && remote.view().workflowId === runId);
    remote.kill();
    const cancelled = await killed;
    assert.equal(cancelled.outcome, "cancelled", JSON.stringify(cancelled));
    assert.equal(cancelled.workflowId, runId, "kill reported the parked workflow as cancelled");
    assert.notEqual(cancelled.workflowId, "label-park");
    token = "";
  } finally {
    releaseRead();
    releaseResume();
    if (token) await runWorkflow(library, { resume: token, cancel: true }).catch(() => undefined);
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
