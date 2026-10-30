// Two public-site demos. books.toscrape is recorded, then replayed on another
// category with zero model calls. A three-row CSV is typed into the-internet's
// practice login through for_each.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome, pinTestBrowser } from "../../src/launch";
import type { PageProposal } from "../../src/v1/data-steps";
import { testArtifacts } from "../artifacts";

process.env.BAO_DRIVE = "1";
process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
process.env.BAO_CHROME_NO_SANDBOX = "1";
pinTestBrowser();
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.CURSOR_API_KEY;
delete process.env.BAO_HEAL_CURSOR;
delete process.env.BAO_HEAL_CURSOR_RESPONSE;
delete process.env.BAO_HEAL_FIXTURE;

const ARTIFACTS = testArtifacts("scrape");
const BOOKS = "https://books.toscrape.com/";
const LOGIN = "https://the-internet.herokuapp.com/login";

async function post(port: number, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json.error || text}`);
  return json;
}

async function get(port: number, pathname: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${text}`);
  if (pathname.split("?")[0]?.endsWith(".csv")) return text;
  return text ? JSON.parse(text) : {};
}

async function until(label: string, fn: () => Promise<boolean>): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 25000) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timeout ${label} ${last}`);
}

test("books.toscrape: record a category list, replay another category, CSV matches the site", { timeout: 240_000 }, async () => {
  process.env.BAO_RUN_VIDEO = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-books-"));
  const app = await startApp({ home, port: 0 });
  let runId = "";
  try {
    await post(app.port, "/api/sessions", { url: BOOKS });
    await post(app.port, "/api/sessions/drive", { click: "a[href*='mystery_']" });
    await until("mystery", async () => {
      const page = await get(app.port, "/api/sessions/page") as { url?: string };
      return !!page.url?.includes("mystery");
    });
    const proposal = await post(app.port, "/api/sessions/extract/propose", { selector: "article.product_pod" }) as PageProposal;
    assert.equal(proposal.mode, "list", JSON.stringify(proposal).slice(0, 500));
    assert.ok((proposal.count || 0) >= 2, JSON.stringify(proposal.columns));
    const names: Record<string, string> = {};
    const drop: string[] = [];
    for (const column of proposal.columns) {
      const sample = column.samples.join(" ");
      if (column.read === "title" || column.name === "title") names[column.id] = "title";
      else if (column.read === "rating" || column.name === "rating" || /^(One|Two|Three|Four|Five)$/.test(column.samples[0] || "")) names[column.id] = "rating";
      else if (/£\d/.test(sample) || column.name.includes("price")) names[column.id] = "price";
      else drop.push(column.id);
    }
    assert.deepEqual(Object.values(names).sort(), ["price", "rating", "title"]);
    await post(app.port, "/api/sessions/extract/commit", { names, drop, maxPages: 3, as: "books", vary: "category" });
    const workflow = await post(app.port, "/api/sessions/stop") as {
      id: string;
      version: number;
      startUrl: string;
      inputs: { name: string; type: string; default?: string }[];
      steps: { action: string; extract?: { pagination?: { maxPages: number } } }[];
      outputs?: { name: string; type: string }[];
    };
    assert.equal(workflow.version, 3);
    assert.match(workflow.startUrl, /^https:\/\/books\.toscrape\.com\/?$/);
    const category = workflow.inputs.find((input) => input.name === "category");
    assert.ok(category, JSON.stringify(workflow.inputs));
    assert.equal(category?.default, "Mystery");
    const extract = workflow.steps.find((step) => step.action === "extract");
    assert.equal(extract?.extract?.pagination?.maxPages, 3);
    assert.equal(workflow.outputs?.[0]?.name, "books");

    const run = await post(app.port, "/api/replay", {
      id: workflow.id,
      args: { category: "Historical Fiction" },
    }) as {
      runId: string;
      status: string;
      modelCalls: number;
      failure?: { reason?: string; stepId?: string };
      steps?: { reason?: string; status?: string }[];
      outputs?: { type: string; rows?: Record<string, string>[] }[];
    };
    runId = run.runId;
    assert.equal(run.status, "passed", JSON.stringify({ failure: run.failure, steps: run.steps }));
    assert.equal(run.modelCalls, 0);
    const table = run.outputs?.find((item) => item.type === "table");
    const page = await get(app.port, `/api/replay/page?id=${encodeURIComponent(workflow.id)}`) as { text?: string };
    const shown = Number((page.text || "").match(/(\d+)\s+results/i)?.[1] || "0");
    assert.ok(shown > 0, page.text?.slice(0, 300));
    assert.equal(table?.rows?.length, shown, `csv ${table?.rows?.length} site ${shown}`);
    const csv = await get(app.port, `/api/runs/${encodeURIComponent(run.runId)}/outputs.csv?name=books`) as string;
    const csvRows = csv.trim().split(/\n/).length - 1;
    assert.equal(csvRows, shown);
    const header = csv.split(/\n/)[0] || "";
    for (const name of ["title", "price", "rating"]) assert.match(header, new RegExp(`\\b${name}\\b`));
    assert.match(csv, /£/);
    console.log(JSON.stringify({ demo: "books", category: "Historical Fiction", rows: table?.rows?.length, site: shown, modelCalls: run.modelCalls, csvRows }));

    mkdirSync(ARTIFACTS, { recursive: true });
    const uiProfile = mkdtempSync(path.join(tmpdir(), "bao-ui-"));
    const ui = await launchOwnedChrome({ userDataDir: uiProfile, headless: true });
    try {
      const uiPage = ui.pages()[0] || await ui.newPage();
      await uiPage.addInitScript(() => {
        localStorage.setItem("bao-onboarded", "1");
        localStorage.setItem("bao-theme", "light");
      });
      await uiPage.goto(`http://127.0.0.1:${app.port}/`);
      await uiPage.click("button[data-screen=runs]");
      await uiPage.click(`button[data-open-run="${run.runId}"]`);
      await uiPage.waitForSelector("#run-outputs");
      await uiPage.locator("#run-outputs").screenshot({ path: path.join(ARTIFACTS, "scrape-outputs-light.png") });
      await uiPage.evaluate(() => localStorage.setItem("bao-theme", "dark"));
      await uiPage.reload();
      await uiPage.click("button[data-screen=runs]");
      await uiPage.click(`button[data-open-run="${run.runId}"]`);
      await uiPage.waitForSelector("#run-outputs");
      await uiPage.locator("#run-outputs").screenshot({ path: path.join(ARTIFACTS, "scrape-outputs-dark.png") });
    } finally {
      await ui.close();
    }
  } finally {
    await app.close();
  }
  const webm = path.join(home, "videos", `${runId}.webm`);
  assert.equal(existsSync(webm), true, webm);
  assert.ok(statSync(webm).size > 1000, String(statSync(webm).size));
  copyFileSync(webm, path.join(ARTIFACTS, "scrape-replay.webm"));
});

test("for_each types a 3-row CSV into the-internet login and submits every row", { timeout: 180_000 }, async () => {
  delete process.env.BAO_RUN_VIDEO;
  const home = mkdtempSync(path.join(tmpdir(), "bao-form-"));
  const app = await startApp({ home, port: 0 });
  const csv = [
    "username,password",
    "ada@example.com,example",
    "grace@example.com,example",
    "linus@example.com,example",
  ].join("\n");
  try {
    await post(app.port, "/api/sessions", { url: LOGIN });
    await until("login form", async () => {
      const page = await get(app.port, "/api/sessions/page") as { text?: string };
      return !!page.text?.includes("Login Page");
    });
    await post(app.port, "/api/sessions/table", { csv, as: "people" });
    for (const user of ["ada@example.com", "grace@example.com", "linus@example.com"]) {
      await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: user } });
      await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "example" } });
      await post(app.port, "/api/sessions/drive", { click: "button[type=submit]" });
      await until(user, async () => {
        const page = await get(app.port, "/api/sessions/page") as { text?: string };
        return !!page.text?.includes("Your username is invalid");
      });
    }
    const workflow = await post(app.port, "/api/sessions/stop") as {
      id: string;
      version: number;
      inputs: { name: string; type: string }[];
      steps: { action: string; forEach?: { over: { kind: string; name: string }; steps: { value?: string }[] } }[];
    };
    const blob = JSON.stringify(workflow);
    assert.equal(workflow.version, 3);
    assert.equal(blob.includes("ada@example.com"), false);
    const loop = workflow.steps.find((step) => step.action === "for_each");
    assert.equal(loop?.forEach?.over.kind, "input");
    const table = workflow.inputs.find((input) => input.type === "table");
    const secret = workflow.inputs.find((input) => input.type === "secret");
    assert.ok(table && secret, JSON.stringify(workflow.inputs));
    assert.ok(loop?.forEach?.steps.some((step) => step.value === "{{row.username}}"), JSON.stringify(loop?.forEach?.steps));
    const run = await post(app.port, "/api/replay", {
      id: workflow.id,
      args: { [table!.name]: csv, [secret!.name]: "example" },
    }) as {
      status: string;
      modelCalls: number;
      failure?: { reason?: string };
      steps?: { action?: string; reason?: string; status?: string }[];
      network?: { method?: string; url: string }[];
    };
    assert.equal(run.status, "passed", JSON.stringify({ failure: run.failure, steps: run.steps }));
    assert.equal(run.modelCalls, 0);
    assert.ok(run.steps?.some((step) => step.reason === "3 rows"), JSON.stringify(run.steps));
    const posts = (run.network || []).filter((item) => item.method === "POST" && /authenticate/.test(item.url));
    assert.equal(posts.length, 3, JSON.stringify(run.network));
    const page = await get(app.port, `/api/replay/page?id=${encodeURIComponent(workflow.id)}`) as { text?: string };
    assert.match(page.text || "", /Your username is invalid/);
    console.log(JSON.stringify({ demo: "form", rows: 3, submits: posts.length, modelCalls: run.modelCalls }));
  } finally {
    await app.close();
  }
});
