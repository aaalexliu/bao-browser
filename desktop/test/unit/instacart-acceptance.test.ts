// Plan W7, lane L1: the hermetic acceptance test for "put costco blueberries
// into the cart at instacart". A scripted MCP client stands in for the agent.
// It drives the one `bao mcp` server, which sends the live tools to a spawned
// `bao serve` with a temp home. The app drives the pinned test Chromium, which
// maps www.instacart.com to the Instacart fixture and every other host to
// NOTFOUND. No model runs. Every spawned process gets a temp HOME, and the app
// takes its own live lock, so nothing touches the daily Chrome, its profile,
// another Bao, or the real site.
//
// The plan's assertions:
//   A  after recording, the cart is one line: Costco, Kirkland Organic Blueberries 3 lb, qty 1
//   B  the write follows the audit row of the click that made it, and only the test browser reached the fixture
//   C  no trap page loaded, and bao refused each trap the client tried
//   D  the disconnect saved a valid, clean cdp-live workflow with the query input, the search submit, and the Add
//   E  two replays through run_workflow pass with no model call and leave the same cart line

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";
import Ajv from "ajv/dist/2020";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";
import { COMMIT_FLOOR, guardPreset } from "../../src/cdp-live/presets";
import { McpClient } from "../../src/eval/mcp-client";
import type { WorkflowOutcome } from "../../src/mcp/catalog";
import { validateWorkflow } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { TARGET, TARGET_PATH, startInstacartFixture, type CartWrite, type Hit, type InstacartFixture } from "../instacart/fixture";
import { applyHermeticApp } from "../runtime";

const INTENT = "put costco blueberries into the cart at instacart";
const WORKFLOW_ID = "wf-put-costco-blueberries-into-the-cart";
const PRODUCT_PATH = TARGET_PATH.split("?")[0];
const CLI = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
const instacart = guardPreset("instacart");
const validateSchema = new Ajv({ allErrors: true, strict: false })
  .compile(JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8")));

interface LiveView {
  path?: string;
  epoch: number;
  pages: number;
  credentialFields: number;
  controls: { ref: string; label: string; kind: string }[];
  stopBeforeConfirm: { label: string }[];
}

interface LiveReply {
  session?: string;
  outcome?: { kind?: string; reason?: string };
  view?: LiveView | null;
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One live tool call. bao mcp marks a refused, halted, or rejected reply as an error, so the caller says which it expects. */
async function live(client: McpClient, name: string, args: Record<string, unknown>, expect: "ok" | "error" = "ok"): Promise<LiveReply> {
  const result = await client.call(name, args);
  assert.equal(result.isError, expect === "error", `${name} ${result.text.slice(0, 400)}`);
  const reply = JSON.parse(result.text) as LiveReply;
  if (expect === "ok") assert.equal(reply.outcome?.kind, "applied", `${name} ${JSON.stringify(reply.outcome)}`);
  return reply;
}

function viewOf(reply: LiveReply): LiveView {
  assert.ok(reply.view, JSON.stringify(reply.outcome));
  assert.equal(reply.view.pages, 1, "each fixture page fits one snapshot page");
  return reply.view;
}

function refOf(reply: LiveReply, what: string, match: (control: { label: string; kind: string }) => boolean): string {
  const view = viewOf(reply);
  const ref = view.controls.find(match)?.ref || "";
  assert.ok(ref, `${what} in ${view.controls.map((item) => item.label).join(" | ")}`);
  return ref;
}

/**
 * The ref of a control the reply names under stopBeforeConfirm and gives no ref. bao numbers
 * each labelled control in page order. On a page with no credential field, the numbers missing
 * from `controls` belong to the stopBeforeConfirm controls, in the same order. An agent can
 * guess the same ref, so this is how the client tries a trap.
 */
function withheldRef(reply: LiveReply, label: string): string {
  const view = viewOf(reply);
  assert.equal(view.credentialFields, 0);
  const at = view.stopBeforeConfirm.findIndex((item) => item.label === label);
  assert.ok(at >= 0, `${label} in stopBeforeConfirm: ${view.stopBeforeConfirm.map((item) => item.label).join(" | ")}`);
  const shown = new Set(view.controls.map((item) => Number(item.ref.split(".c")[1])));
  const withheld: number[] = [];
  for (let index = 0; withheld.length <= at; index += 1) if (!shown.has(index)) withheld.push(index);
  return `e${view.epoch}.c${withheld[at]}`;
}

/** Keys anywhere in a JSON document. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

interface Serve {
  close(): Promise<void>;
}

/** `bao serve` as a person starts it: a temp home, the test browser as the live target, and its own live lock. */
async function startServe(env: NodeJS.ProcessEnv, home: string, portFile: string, lockFile: string): Promise<Serve> {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    CLI, "serve", "--home", home, "--port", "0",
    "--live-target", `throwaway:${portFile}`, "--live-lock", lockFile,
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await until(() => {
    if (proc.exitCode !== null) throw new Error(`bao serve exited ${proc.exitCode}: ${stderr}`);
    return /^bao \d+ home /m.test(stdout) ? true : undefined;
  }, "bao serve", 60_000);
  return {
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

test("bao serve takes its own live lock only for a throwaway Chrome, so every Bao on the daily Chrome shares one", () => {
  const env = { ...process.env };
  const home = applyHermeticApp("instacart-acceptance-lock", env).home;
  const root = path.dirname(home);
  env.HOME = path.join(root, "user");
  mkdirSync(env.HOME, { recursive: true });
  try {
    const served = spawnSync(process.execPath, [CLI, "serve", "--home", home, "--port", "0", "--live-lock", path.join(root, "live.lock")], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(served.status, 1, served.stderr);
    assert.match(served.stderr, /--live-lock needs --live-target throwaway:/);
    assert.equal(existsSync(path.join(home, "server.json")), false, "the app never started");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("L1: a scripted agent puts Costco blueberries in the cart through bao mcp, and bao replays it", { timeout: 300_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;
  let serve: Serve | undefined;
  let root: string;
  let home: string;
  let lockFile: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
    env = { ...process.env };
    home = applyHermeticApp("instacart-acceptance", env).home;
    root = path.dirname(home);
    env.HOME = path.join(root, "user");
    mkdirSync(env.HOME, { recursive: true });
    lockFile = path.join(root, "live.lock");
    serve = await startServe(env, home, browser.portFile, lockFile);
  });

  after(async () => {
    await serve?.close();
    await browser?.close();
    await fixture?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("records the task, saves it when the agent disconnects, refuses the traps, and replays it twice with no model", async () => {
    const library = new Library(home);
    const file = path.join(home, "workflows", `${WORKFLOW_ID}.json`);
    // fixture.reset() clears its logs, so every request and trap hit is kept here first.
    const requests: Hit[] = [];
    const trapHits: Hit[] = [];
    const resetCart = (): void => {
      requests.push(...fixture.state().requests);
      trapHits.push(...fixture.state().traps);
      fixture.reset();
    };
    const writes = () => fixture.state().writes.map((write) => [write.op, write.store, write.productId, write.after]);
    const oneLine = () => {
      const { carts } = fixture.state();
      assert.deepEqual(carts.costco.map((line) => [line.productId, line.name, line.qty]), [[TARGET.id, TARGET.name, 1]]);
      assert.deepEqual([carts.safeway, carts.sprouts], [[], []]);
    };

    // Record, the way an agent drives the live tools. The client never calls live_stop.
    resetCart();
    const agent = McpClient.start(env);
    const traps = new Map<string, LiveReply["outcome"]>();
    let recorded: CartWrite[] = [];
    try {
      const tools = await agent.handshake();
      for (const name of ["live_session_start", "live_snapshot", "live_click", "live_type", "live_key", "live_stop", "run_workflow"]) {
        assert.ok(tools.includes(name), `the one bao server lists ${name}`);
      }
      const started = await live(agent, "live_session_start", { intent: INTENT, url: fixture.url("/store/costco/storefront") });
      assert.equal(started.session, WORKFLOW_ID);
      const search = (reply: LiveReply) => refOf(reply, "the search box", (item) => item.label === "Search Costco");
      const typed = await live(agent, "live_type", { ref: search(started), text: "blueberries" });
      const results = await live(agent, "live_key", { key: "Enter", ref: search(typed) });
      assert.equal(viewOf(results).path, "/store/costco/s");

      // The store's Checkout link (to /checkout) and the header's Log in link. Each is refused before the page is touched.
      for (const label of ["Checkout", "Log in"]) {
        traps.set(label, (await live(agent, "live_click", { ref: withheldRef(results, label) }, "error")).outcome);
      }

      const listed = await live(agent, "live_snapshot", {});
      const product = await live(agent, "live_click", {
        ref: refOf(listed, TARGET.name, (item) => item.kind === "link" && item.label.includes(TARGET.name)),
      });
      assert.equal(viewOf(product).path, PRODUCT_PATH);
      const added = await live(agent, "live_click", { ref: refOf(product, "Add to cart", (item) => item.label === "Add to cart") });
      await until(() => (fixture.state().writes.length ? true : undefined), "the cart write");

      // The cart's own /checkout link, which shows once the cart holds the item.
      const cart = await live(agent, "live_click", { ref: refOf(added, "the cart button", (item) => item.label.startsWith("View Cart")) });
      assert.ok(viewOf(cart).stopBeforeConfirm.some((item) => item.label === "Go to checkout"), JSON.stringify(viewOf(cart).stopBeforeConfirm));
      traps.set("Go to checkout", (await live(agent, "live_click", { ref: withheldRef(cart, "Go to checkout") }, "error")).outcome);
      recorded = fixture.state().writes;
      assert.equal(existsSync(file), false, "nothing is saved while the session is open");
    } finally {
      // The agent goes away without live_stop. bao mcp tells the app, and the app saves the session.
      await agent.close();
    }
    await until(() => (existsSync(file) ? true : undefined), "the workflow saved on disconnect");
    await until(() => (existsSync(lockFile) ? undefined : true), "the live lock released on disconnect");
    const session = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as LiveSessionRecord;
    assert.equal(session.id, WORKFLOW_ID);
    assert.notEqual(session.status, "running");

    // A: one Costco line, the owner's item, qty 1.
    oneLine();
    assert.deepEqual(recorded.map((write) => [write.op, write.store, write.productId, write.after]), [["add", "costco", TARGET.id, 1]]);

    // B: the cart write came after the audit row of the trusted Add click, with no row between them.
    for (const write of recorded) {
      const prior = session.audit.filter((row) => row.at <= write.at);
      const row = prior[prior.length - 1];
      assert.deepEqual([row?.action, row?.label, row?.path, row?.isTrusted], ["click", "Add to cart", PRODUCT_PATH, true], JSON.stringify(row));
    }

    // C: each trap refused on its label, and its refusal audited.
    assert.deepEqual([...traps.keys()], ["Checkout", "Log in", "Go to checkout"]);
    for (const [label, outcome] of traps) assert.deepEqual(outcome, { kind: "refused", reason: "denied" }, label);
    assert.equal(session.audit.filter((row) => row.action === "click" && row.label === "denied").length, traps.size);

    // D: the workflow the disconnect saved.
    const workflow = library.read(WORKFLOW_ID);
    assert.deepEqual(validateWorkflow(workflow), []);
    assert.equal(validateSchema(workflow), true, JSON.stringify(validateSchema.errors));
    assert.equal(workflow.driver, "cdp-live");
    assert.equal(new URL(workflow.startUrl).host, "www.instacart.com");
    assert.equal(workflow.intent, INTENT);
    assert.deepEqual(workflow.inputs.map((input) => [input.name, input.type, input.default]), [["query", "text", "blueberries"]]);
    const [type, enter, open, add, openCart] = workflow.steps;
    assert.equal(workflow.steps.length, 5, workflow.steps.map((step) => step.label).join(" | "));
    assert.deepEqual([type?.action, type?.input, type?.value, type?.identity?.name], ["type", "query", "{{query}}", "Search Costco"]);
    assert.deepEqual([enter?.action, enter?.key, enter?.identity?.name], ["key", "Enter", "Search Costco"]);
    assert.deepEqual([open?.action, open?.identity?.role, open?.identity?.href?.endsWith(TARGET_PATH)], ["click", "link", true]);
    assert.deepEqual([add?.action, add?.identity?.text, add?.identity?.testId, add?.expect?.match, add?.human], ["click", "Add to cart", "add-to-cart-button", "1 in cart", undefined]);
    assert.equal(openCart?.action, "click");
    assert.match(openCart?.identity?.name || "", /^View Cart/);
    assert.deepEqual([...keysOf(workflow)].filter((key) => /cookie|storage/i.test(key)), []);
    for (const step of workflow.steps) {
      for (const source of [instacart.deny, instacart.commit, COMMIT_FLOOR]) {
        assert.equal(new RegExp(source, "i").test(step.label), false, `${step.label} matches ${source}`);
      }
    }

    // E: replay through run_workflow from a new client, on an empty cart each time.
    const replayer = McpClient.start(env);
    try {
      await replayer.handshake();
      const runWorkflow = async (args: Record<string, unknown>) => {
        const result = await replayer.call("run_workflow", { id: WORKFLOW_ID, ...args });
        assert.equal(result.isError, false, result.text);
        const outcome = JSON.parse(result.text) as WorkflowOutcome;
        const run = library.readRun(outcome.runId || "");
        assert.equal(run.modelCalls, 0, result.text);
        assert.deepEqual(run.heals, []);
        return { outcome, run };
      };
      for (const round of [1, 2]) {
        resetCart();
        const { outcome, run } = await runWorkflow({});
        assert.equal(outcome.outcome, "ok", `round ${round}: ${JSON.stringify(outcome)}`);
        assert.equal(run.status, "passed");
        assert.deepEqual(outcome.receipts.map((step) => step.status), ["passed", "passed", "passed", "passed", "passed"]);
        assert.deepEqual(run.inputs, { query: "blueberries" });
        oneLine();
        assert.deepEqual(writes(), [["add", "costco", TARGET.id, 1]], `round ${round}`);
        assert.deepEqual(fixture.state().requests.filter((hit) => hit.path.startsWith("/store/costco/s?")).map((hit) => hit.path), ["/store/costco/s?k=blueberries"]);
      }

      // New search text: the replay searches it, cannot open the blueberries it recorded, and stops before any cart write.
      resetCart();
      const { outcome, run } = await runWorkflow({ inputs: { query: "strawberries" } });
      assert.equal(outcome.outcome, "failed", JSON.stringify(outcome));
      assert.equal(outcome.reason, "find: below-threshold");
      assert.deepEqual(outcome.receipts.map((step) => step.status), ["passed", "passed", "failed", "pending", "pending"]);
      assert.deepEqual(run.inputs, { query: "strawberries" });
      assert.deepEqual(fixture.state().requests.map((hit) => hit.path), ["/store/costco/storefront", "/store/costco/s?k=strawberries"]);
      assert.deepEqual(writes(), []);
    } finally {
      await replayer.close();
    }

    // B and C over the whole run, recording and replays.
    resetCart();
    assert.deepEqual(trapHits, [], "no checkout, login, account, or trial page loaded");
    const version = await (await fetch(`${browser.cdpUrl}/json/version`)).json() as { "User-Agent"?: string };
    assert.match(version["User-Agent"] || "", /Chrome\//);
    assert.ok(requests.length > 0);
    assert.deepEqual(
      [...new Set(requests.map((hit) => `${hit.host} ${hit.agent}`))],
      [`www.instacart.com ${version["User-Agent"]}`],
      "every fixture request came from the test browser",
    );
  });
});
