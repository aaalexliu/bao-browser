// Two Macs, a replay, the review gate, and a scripted agent.
// Run after `tsc -p tsconfig.desktop.json`. Chrome needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { pinTestBrowser } from "../../src/launch";
import { reviewWorkflow, runWorkflow } from "../../src/mcp/catalog";
import { frameRpc, takeRpcChunk } from "../../src/mcp/frame";
import { startApp } from "../../src/app/server";
import { migrate, type ReplayArgs, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";
import { SEED_WORKFLOWS } from "../../../web/src/lib/seeds";
import { testArtifacts } from "../artifacts";

process.env.TZ = "America/New_York";
const TEST_BROWSER = pinTestBrowser();

const planted = "SuperSecretValue99";
const fixturePassword = "fixture-pass-value";

test("two devices, review gate, agent, and the web app", { timeout: 720_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-live-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const webDir = path.join(process.cwd(), "web");
  execFileSync("npm", ["run", "build"], {
    cwd: webDir,
    env: { ...process.env, BAO_AUTH_STUB: "1" },
    stdio: "pipe",
  });
  const web = spawn("npm", ["run", "start", "--", "--port", String(port), "-H", "127.0.0.1"], {
    detached: true,
    cwd: webDir,
    env: {
      ...process.env,
      BAO_PG_DIR: path.join(root, "pglite"),
      BAO_BLOB_DIR: path.join(root, "blobs"),
      BAO_AUTH_STUB: "1",
      BAO_CHROME_NO_SANDBOX: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  try {
    await waitHealth(origin, logs);
    const owner = await signIn(origin, "owner@bao.local");
    const examples = await signIn(origin, "examples@bao.local");
    const homeA = path.join(root, "mac-a");
    const homeB = path.join(root, "mac-b");
    const libA = new Library(homeA);
    const libB = new Library(homeB);
    const fixture = `${origin}/fixture.html`;
    const doc = localCopy("fixture-username", "cross-mac", fixture);
    doc.name = "From the first Mac";
    libA.save(doc);

    await pairDevice(libA, { code: await pairCode(origin, owner), server: origin, name: "Mac A" });
    await pairDevice(libB, { code: await pairCode(origin, owner), server: origin, name: "Mac B" });
    const first = await syncAll(libA);
    assert.ok(first.backupPath && statSync(first.backupPath).isDirectory());
    assert.ok(statSync(path.join(first.backupPath, "workflows", "cross-mac.json")).isFile());
    assert.equal(statSync(path.join(homeA, "sync.json")).mode & 0o777, 0o600);
    const tokenA = JSON.parse(readFileSync(path.join(homeA, "sync.json"), "utf8")).deviceToken as string;
    assert.ok(tokenA);

    const pulled = await syncAll(libB);
    assert.equal(libB.read("cross-mac").name, "From the first Mac");
    assert.ok(pulled.devices.length >= 2);
    assert.ok(pulled.categories.some((row) => row.count >= 1));
    const replayed = await runWorkflow(libB, { id: "cross-mac", inputs: { username: "grace" } });
    assert.equal(replayed.outcome, "ok", JSON.stringify(replayed));

    libA.rename("cross-mac", "From the first Mac again");
    await syncAll(libA);
    libB.rename("cross-mac", "Edited on the second Mac");
    const conflicted = await syncAll(libB);
    assert.equal(libB.read("cross-mac").name, "Edited on the second Mac");
    const stashed = readFileSync(path.join(homeB, "conflicts", "cross-mac.json"), "utf8");
    assert.match(stashed, /Edited on the second Mac/);
    assert.ok(conflicted.conflicts.some((item) => item.id === "cross-mac"));
    const again = await syncAll(libA);
    assert.equal(again.backupPath, first.backupPath);

    const wiki = localCopy("wikipedia-search", "wiki-roundtrip", "https://en.wikipedia.org/wiki/Main_Page");
    wiki.name = "Wikipedia search";
    libA.save(wiki);
    const wikiPush = await syncAll(libA, "push");
    assert.equal((wikiPush.lastResult || "").includes("refused"), false, wikiPush.lastResult);
    await syncAll(libB, "pull");
    assert.equal(libB.read("wiki-roundtrip").startUrl, "https://en.wikipedia.org/wiki/Main_Page");
    process.env.BAO_RUN_VIDEO = "1";
    const wikiRun = await runWorkflow(libB, { id: "wiki-roundtrip", inputs: { query: "Ada Lovelace" } });
    delete process.env.BAO_RUN_VIDEO;
    assert.equal(wikiRun.outcome, "ok", JSON.stringify(wikiRun));
    const webm = readdirSync(path.join(homeB, "videos")).find((name) => name.endsWith(".webm"));
    assert.ok(webm, "replay video was not saved");
    const frame = path.join(testArtifacts("registry"), "wikipedia-replay-frame.png");
    mkdirSync(path.dirname(frame), { recursive: true });
    const videoFile = path.join(homeB, "videos", webm);
    try {
      execFileSync("ffmpeg", ["-y", "-ss", "1", "-i", videoFile, "-frames:v", "1", frame], { stdio: "pipe" });
    } catch {
      execFileSync("ffmpeg", ["-y", "-i", videoFile, "-frames:v", "1", frame], { stdio: "pipe" });
    }
    assert.ok(statSync(frame).size > 1000);

    const bad = await fetch(`${origin}/api/workflows/bad-secret/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: 0,
        document: {
          ...localCopy("fixture-username", "bad-secret", fixture),
          inputs: [{ name: "password", type: "secret", default: planted }],
        },
        cookie: "session=secretcookie",
        args: { password: planted },
      }),
    });
    const badText = await bad.text();
    assert.equal(bad.status, 400, badText);
    const absent = await fetch(`${origin}/api/workflows/bad-secret`, { headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(absent.status, 404);
    const stored = await fetch(`${origin}/api/workflows/cross-mac`, { headers: { authorization: `Bearer ${tokenA}` } });
    const storedText = await stored.text();
    assert.equal(stored.ok, true);
    assert.equal(storedText.includes(planted), false);
    assert.equal(storedText.includes("secretcookie"), false);

    const shared = await fetch(`${origin}/api/workflows/fixture-sign-in/share`, {
      method: "POST",
      headers: { cookie: examples, "content-type": "application/json" },
      body: JSON.stringify({ permission: "fork" }),
    });
    const shareBody = await shared.json() as { token: string; document?: unknown };
    assert.equal(shared.ok, true, JSON.stringify(shareBody));
    const share = await fetch(`${origin}/api/share/${shareBody.token}`, { headers: { cookie: examples } });
    const shareView = await share.json() as { questions: { name: string; type: string }[]; document: unknown };
    assert.ok(shareView.questions.some((question) => question.type === "secret"));
    assert.equal(JSON.stringify(shareView.document).includes("@"), false);
    const reader = await signIn(origin, "reader@bao.local");
    const leaked = await fetch(`${origin}/api/share/${shareBody.token}/install`, {
      method: "POST",
      headers: { cookie: reader, "content-type": "application/json" },
      body: JSON.stringify({ answers: { username: "ada@secret.com", password: fixturePassword } }),
    });
    assert.equal(leaked.status, 400);

    const noted = localCopy("fixture-username", "noted-hello", "http://127.0.0.1/fixture.html");
    noted.name = "Hello with a note";
    noted.inputs.push({ name: "note", type: "text", label: "Note", required: false, default: "ada@acme.com" });
    const pushed = await fetch(`${origin}/api/workflows/noted-hello/versions`, {
      method: "POST",
      headers: { cookie: examples, "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 0, document: noted }),
    });
    assert.equal(pushed.status, 201, await pushed.text());
    const early = await fetch(`${origin}/api/workflows/noted-hello/publish`, {
      method: "POST",
      headers: { cookie: examples },
    });
    assert.equal(early.status, 409);

    for (const seed of SEED_WORKFLOWS) {
      if (!seed.id.startsWith("fixture-")) continue;
      const current = await fetch(`${origin}/api/workflows/${seed.id}`, { headers: { cookie: examples } });
      const pulled = await current.json() as { version: number; document: WorkflowV2 };
      const doc = migrate(pulled.document);
      doc.startUrl = fixture;
      const retargeted = await fetch(`${origin}/api/workflows/${seed.id}/versions`, {
        method: "POST",
        headers: { cookie: examples, "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: pulled.version, document: doc }),
      });
      assert.equal(retargeted.status, 201, await retargeted.text());
    }

    const published: string[] = [];
    for (const seed of SEED_WORKFLOWS) {
      const inputs = seedInputs(seed.id, fixture);
      const result = await reviewWorkflow(new Library(path.join(root, `review-${seed.id}`)), seed.id, inputs, {
        server: origin,
        cookie: examples,
        startUrl: seed.id.startsWith("fixture-") ? fixture : undefined,
      });
      if (result.reviewed) {
        const confirmed = await fetch(`${origin}/api/workflows/${seed.id}/publish`, {
          method: "POST",
          headers: { cookie: examples, "content-type": "application/json" },
        });
        if (confirmed.ok) published.push(seed.id);
        else logs.push(`publish ${seed.id} ${confirmed.status} ${await confirmed.text()}\n`);
      } else {
        logs.push(`review ${seed.id} ${result.outcome} ${result.reason || ""}\n`);
      }
    }
    for (const id of ["fixture-row", "fixture-username", "fixture-upload", "wikipedia-search", "public-form"]) {
      assert.ok(published.includes(id), `${id} was not listed\n${logs.slice(-40).join("")}`);
    }
    assert.equal(published.includes("fixture-sign-in"), false, `fixture-sign-in was listed without a password\n${logs.slice(-40).join("")}`);
    const publicSignIn = await (await fetch(`${origin}/api/marketplace/fixture-sign-in`)).text();
    assert.equal(publicSignIn.includes(fixturePassword), false);

    const noteReview = await reviewWorkflow(new Library(path.join(root, "review-note")), "noted-hello", { username: "Ada" }, {
      server: origin,
      cookie: examples,
      startUrl: fixture,
    });
    assert.equal(noteReview.reviewed, true, JSON.stringify(noteReview));

    const shots = testArtifacts("registry");
    mkdirSync(shots, { recursive: true });
    const browser = await chromium.launch({ executablePath: TEST_BROWSER, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/New_York" });
      await context.addCookies([{ name: "bao_session", value: examples.split("=")[1] || "", url: origin }]);
      const page = await context.newPage();
      page.on("pageerror", (err) => logs.push(`pageerror ${err.message}\n`));
      page.on("requestfailed", (req) => logs.push(`fail ${req.url()} ${req.failure()?.errorText || ""}\n`));
      await openPage(page, `${origin}/workflows/noted-hello/publish`, logs);
      await page.getByRole("heading", { name: "What goes public" }).waitFor();
      await page.getByTestId("verified").waitFor();
      await page.getByTestId("domains").waitFor();
      assert.match(await page.getByTestId("last-green").innerText(), /Not replayed yet/);
      assert.match(await page.locator("table.diff").innerText(), /ada@acme.com/);
      await page.screenshot({ path: path.join(shots, "publish-preview-light.png"), fullPage: true });
      await clickTheme(page);
      await page.screenshot({ path: path.join(shots, "publish-preview-dark.png"), fullPage: true });
      await clickTheme(page);

      const listed = await fetch(`${origin}/api/workflows/noted-hello/publish`, {
        method: "POST",
        headers: { cookie: examples, "content-type": "application/json" },
      });
      assert.equal(listed.ok, true, await listed.text());
      const publicNote = await (await fetch(`${origin}/api/marketplace/noted-hello`)).text();
      assert.equal(publicNote.includes("ada@acme.com"), false);

      await openPage(page, `${origin}/`, logs);
      await page.getByTestId("library").waitFor();
      await page.screenshot({ path: path.join(shots, "library-light.png"), fullPage: true });
      await clickTheme(page);
      await page.screenshot({ path: path.join(shots, "library-dark.png"), fullPage: true });
      await clickTheme(page);

      await openPage(page, `${origin}/marketplace`, logs);
      await page.getByTestId("marketplace").waitFor();
      for (const id of ["fixture-row", "fixture-username", "fixture-upload", "wikipedia-search", "public-form"]) {
        await page.locator(`[data-testid=listing][data-id="${id}"]`).waitFor();
      }
      assert.equal(await page.locator(`[data-testid=listing][data-id="fixture-sign-in"]`).count(), 0);
      assert.equal(await page.locator("input[name=q]").inputValue(), "");
      const cardText = await page.getByTestId("marketplace").innerText();
      assert.equal(cardText.includes("1 runs"), false);
      assert.match(cardText, /1 run/);
      const marks = await page.locator("[data-testid=listing]").evaluateAll((nodes) => nodes.map((node) => {
        const shot = node.querySelector("img.shot");
        if (shot) return `shot:${shot.getAttribute("src")}`;
        const tile = node.querySelector(".tile");
        return `tile:${tile?.getAttribute("data-letter")}:${tile?.getAttribute("data-domain")}`;
      }));
      assert.equal(new Set(marks).size, marks.length, marks.join("\n"));
      await page.screenshot({ path: path.join(shots, "marketplace-light.png"), fullPage: true });
      await page.screenshot({ path: path.join(shots, "marketplace.png"), fullPage: true });
      await clickTheme(page);
      await page.screenshot({ path: path.join(shots, "marketplace-dark.png"), fullPage: true });
      await clickTheme(page);
      await page.locator(`[data-testid=listing][data-id="wikipedia-search"]`).click();
      await page.getByTestId("workflow").waitFor();
      await page.getByTestId("verified").waitFor();
      await page.getByTestId("perm-sites").waitFor();
      await page.getByTestId("setup-questions").waitFor();
      assert.match(await page.getByTestId("last-green").innerText(), /Publisher replayed green:.*[A-Z][a-z]{2} \d+, \d+:\d{2} (AM|PM) (EDT|EST)/);
      assert.equal(await page.getByTestId("import-link").getAttribute("data-copy"), "bao://import/wikipedia-search");
      assert.equal(await page.getByTestId("deeplink").getAttribute("data-copy"), "bao://workflow/wikipedia-search");
      assert.equal((await page.getByTestId("workflow").innerText()).includes("bao://"), false);
      await page.getByTestId("allow").click();
      await page.getByTestId("install").waitFor();
      assert.equal(await page.getByTestId("install").getAttribute("href"), "bao://import/wikipedia-search");
      await page.screenshot({ path: path.join(shots, "workflow-light.png"), fullPage: true });
      await page.screenshot({ path: path.join(shots, "workflow.png"), fullPage: true });
      await clickTheme(page);
      await page.screenshot({ path: path.join(shots, "workflow-dark.png"), fullPage: true });

      const fresh = await context.newPage();
      await openPage(fresh, `${origin}/login`, logs);
      await fresh.locator("input[name=email]").fill("guest@bao.local");
      await fresh.getByRole("button", { name: "Email me a link" }).click();
      await fresh.getByRole("link", { name: "Open the sign-in link" }).click();
      await fresh.getByRole("heading", { name: "Library" }).waitFor();
    } finally {
      await browser.close();
    }

    const transcript = await agentExchange(path.join(root, "agent"), origin, owner);
    const transcriptPath = path.join(testArtifacts("registry"), "agent-transcript.json");
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
    assert.equal(JSON.stringify(transcript).includes(fixturePassword), false);
    assert.equal(transcript.run.outcome, "ok");
    assert.ok(transcript.search.hits.length <= 5);
    assert.ok(transcript.search.hits.every((hit) => Array.isArray(hit.inputs)));
    assert.equal(transcript.tools.join(","), "search_workflows,describe_workflow,run_workflow,get_run");

    const app = await startApp({ home: homeB });
    try {
      const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).text();
      const tokenB = JSON.parse(readFileSync(path.join(homeB, "sync.json"), "utf8")).deviceToken as string;
      assert.equal(state.includes(tokenB), false);
      const desktop = await chromium.launch({ executablePath: TEST_BROWSER, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      try {
        const desk = await desktop.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: "America/New_York" });
        const page = await desk.newPage();
        await page.goto(`http://127.0.0.1:${app.port}/`);
        await page.getByRole("button", { name: "Library" }).click();
        await page.getByText("Edited on the second Mac").waitFor();
        await page.locator("article.wf-card", { hasText: "Edited on the second Mac" }).getByRole("button", { name: "Run" }).click();
        await page.getByText("bao://workflow/cross-mac").waitFor();
        await page.getByRole("button", { name: "Re-run with past inputs" }).waitFor();
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("heading", { name: "Devices" }).waitFor();
        await page.getByTestId("devices").getByText("Mac A", { exact: true }).waitFor();
        await page.getByText("Conflicts", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Open my copy" }).waitFor();
        await page.getByRole("button", { name: "Keep mine instead" }).waitFor();
        await page.getByText("before-sync-").waitFor();
        await page.getByRole("button", { name: "Open my copy" }).click();
        await page.getByTestId("my-copy").waitFor();
        assert.match(await page.getByTestId("my-copy").innerText(), /Edited on the second Mac/);
        assert.match(await page.getByTestId("sync-result").innerText(), /conflicts 1/);
        assert.equal(await page.locator("#theme-toggle").count(), 0);
        await page.locator(".card", { has: page.locator("#settings-model") }).waitFor();
        await page.locator(".card", { has: page.locator("#settings-helper") }).waitFor();
        assert.equal(await page.getByText("Two permissions on the Mac").count(), 0);
        const deviceTime = await page.getByTestId("device-row").first().innerText();
        assert.match(deviceTime, /just now|min ago|hour ago|day ago/);
        assert.equal(deviceTime.includes("T") && deviceTime.includes("Z"), false);
        assert.match(await page.getByTestId("last-synced").innerText(), /Oct \d+, \d+:\d{2} (AM|PM) (EDT|EST)/);
        await page.screenshot({ path: path.join(shots, "desktop-sync-light.png"), fullPage: true });
        await page.screenshot({ path: path.join(shots, "desktop-sync.png"), fullPage: true });
        await page.locator("#theme").selectOption("dark");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        await page.screenshot({ path: path.join(shots, "desktop-sync-dark.png"), fullPage: true });
        const lightHash = createHash("md5").update(readFileSync(path.join(shots, "desktop-sync-light.png"))).digest("hex");
        const darkHash = createHash("md5").update(readFileSync(path.join(shots, "desktop-sync-dark.png"))).digest("hex");
        assert.notEqual(lightHash, darkHash);
        await page.locator("#theme").selectOption("light");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
        const secretDoc = localCopy("fixture-username", "secret-push", fixture);
        secretDoc.inputs = [
          ...secretDoc.inputs,
          { name: "password", type: "secret", label: "Password", required: true },
        ];
        libB.save(secretDoc);
        libB.noteHealPromotion("secret-push", { args: { password: planted } });
        await page.getByRole("button", { name: "Push" }).click();
        await page.getByTestId("sync-error").waitFor({ timeout: 30_000 });
        const errorText = await page.getByTestId("sync-error").innerText();
        assert.match(errorText, /secret param/);
        assert.equal(errorText.includes(planted), false);
        const hidden = await fetch(`${origin}/api/workflows/secret-push`, { headers: { authorization: `Bearer ${tokenB}` } });
        assert.equal(hidden.status, 404);
        await page.screenshot({ path: path.join(shots, "secret-push-light.png"), fullPage: true });
        await page.locator("#theme").selectOption("dark");
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        await page.screenshot({ path: path.join(shots, "secret-push-dark.png"), fullPage: true });
      } finally {
        await desktop.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await stop(web);
  }
});

async function agentExchange(home: string, origin: string, ownerCookie: string) {
  const library = new Library(home);
  const doc = localCopy("fixture-sign-in", "agent-sign-in", `${origin}/fixture.html`);
  library.save(doc);
  for (let i = 0; i < 6; i++) {
    const extra = localCopy("fixture-username", `extra-${i}`, `${origin}/fixture.html`);
    extra.name = `Extra search ${i}`;
    library.save(extra);
  }
  await pairDevice(library, { code: await pairCode(origin, ownerCookie), server: origin, name: "Agent Mac" });
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, BAO_HOME: home, BAO_CHROME_NO_SANDBOX: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: { id?: number; result?: { tools?: { name: string }[]; content?: { text: string }[] } }[] = [];
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      messages.push(JSON.parse(next.body));
      buf = Buffer.from(next.rest);
    }
  });
  const send = (msg: unknown) => child.stdin.write(frame(msg));
  const waitFor = async (id: number) => {
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      if (messages.some((msg) => msg.id === id)) return messages.find((msg) => msg.id === id);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`agent timed out waiting for ${id}`);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_workflows", arguments: { query: "sign in" } } });
    const searchMsg = await waitFor(3);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "describe_workflow", arguments: { id: "agent-sign-in" } } });
    const describeMsg = await waitFor(4);
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: "agent-sign-in", inputs: { username: "grace", password: fixturePassword } } },
    });
    const runMsg = await waitFor(5);
    const text = (msg: { result?: { content?: { text: string }[] } } | undefined) => msg?.result?.content?.[0]?.text || "";
    const search = JSON.parse(text(searchMsg)) as { hits: { inputs: unknown[] }[] };
    const described = JSON.parse(text(describeMsg)) as { link?: string };
    const run = JSON.parse(text(runMsg)) as { outcome: string };
    assert.equal(text(runMsg).includes(fixturePassword), false);
    assert.equal(described.link, "bao://workflow/agent-sign-in");
    return {
      tools: listed?.result?.tools?.map((tool) => tool.name) ?? [],
      search,
      describe: described,
      run,
    };
  } finally {
    child.kill();
  }
}

function seedInputs(id: string, _fixture: string): ReplayArgs {
  if (id === "fixture-sign-in") return { username: "ada", password: fixturePassword };
  if (id === "fixture-row") return { row: "Ada" };
  if (id === "fixture-username") return { username: "grace" };
  if (id === "fixture-upload") {
    const file = path.join(tmpdir(), "bao-upload.txt");
    writeFileSync(file, "hello from bao\n");
    return { file: { name: "bao-upload.txt", path: file } };
  }
  if (id === "wikipedia-search") return { query: "Ada Lovelace" };
  if (id === "public-form") return { name: "Ada Lovelace", note: "Leave at the desk" };
  return {};
}

function localCopy(seedId: string, id: string, startUrl: string): WorkflowV2 {
  const seed = SEED_WORKFLOWS.find((item) => item.id === seedId);
  if (!seed) throw new Error(seedId);
  const doc = migrate(JSON.parse(JSON.stringify(seed.document)) as unknown);
  doc.id = id;
  doc.startUrl = startUrl;
  doc.createdAt = Date.now();
  return doc;
}

async function signIn(origin: string, email: string): Promise<string> {
  const sent = await fetch(`${origin}/api/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await sent.json() as { verifyUrl?: string; error?: string };
  if (!body.verifyUrl) throw new Error(body.error || "no verify link");
  const verified = await fetch(`${origin}${body.verifyUrl}`, { redirect: "manual" });
  const match = verified.headers.get("set-cookie")?.match(/bao_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  return `bao_session=${match[1]}`;
}

async function pairCode(origin: string, cookie: string): Promise<string> {
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  const body = await res.json() as { code?: string; error?: string };
  if (!body.code) throw new Error(body.error || "no pair code");
  return body.code;
}

async function waitHealth(origin: string, logs: string[]): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 180_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`web did not start: ${last}\n${logs.join("").slice(-5000)}`);
}

function frame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "json"));
}

async function clickTheme(page: Page): Promise<void> {
  let before = "light";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      before = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || "light");
      break;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  const next = before === "dark" ? "light" : "dark";
  await page.evaluate((theme) => localStorage.setItem("bao-theme", theme), next);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction((theme) => document.documentElement.getAttribute("data-theme") === theme, next, { timeout: 15_000 });
}

async function openPage(
  page: { goto: (url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }) => Promise<{ status: () => number } | null> },
  url: string,
  logs: string[],
): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const status = res?.status() ?? 0;
      if (status > 0 && status < 500) return;
      last = `status ${status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    logs.push(`open ${url} attempt ${attempt} ${last}\n`);
  }
  throw new Error(`could not open ${url}: ${last}\n${logs.slice(-40).join("")}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
