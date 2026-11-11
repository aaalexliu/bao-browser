import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testChromium } from "../../src/test-browser";
import { startApp } from "../../src/app/server";
import type { TeachCard } from "../../src/v1/teach";
import type { WorkflowV2 } from "../../src/v1/schema";
import type { TrailEvent } from "../../src/v1/interpret";

process.env.BAO_DRIVE = "1";

test("the running app confirms one sign-in span and waits through the real recorded challenge", { timeout: 120000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-signin-app-"));
  const fixture = createServer((request, response) => {
    if (request.url === "/account") {
      response.writeHead(302, { location: "/?multi=1" });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(readFileSync(path.join(process.cwd(), "desktop/test/fixtures/signin.html")));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const app = await startApp({ home, port: 0, extensionHost: false });
  const browser = await testChromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const base = `http://127.0.0.1:${app.port}`;
  const post = async <T = unknown>(route: string, body: unknown = {}): Promise<T> => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) assert.fail(`${route}: ${await response.text()}`);
    return await response.json() as T;
  };
  const state = async (): Promise<{ teach: { cards: TeachCard[]; decisions: unknown[] }; activeAsk?: { kind: string } }> =>
    await (await fetch(base + "/api/state")).json() as Awaited<ReturnType<typeof state>>;
  try {
    await post("/api/sessions", { teach: true, url: `http://127.0.0.1:${address.port}/?multi=1` });
    for (const action of [
      { click: "#username" }, { fill: { selector: "#username", value: "fixture-owner" } },
      { click: "#password" }, { fill: { selector: "#password", value: "fixture-password" } },
      { click: "#remember" }, { click: "#signin" },
      { click: "#confirm-password" }, { fill: { selector: "#confirm-password", value: "fixture-password" } },
      { click: "#pin" }, { fill: { selector: "#pin", value: "123456" } }, { press: "Enter" },
    ]) await post("/api/sessions/drive", action);
    await post("/api/teach/check");
    await post("/api/sessions/drive", { click: "#business" });
    const before = await state();
    const card = before.teach.cards.find((item) => item.action === "type" && item.values.some((value) => value.name === "username"));
    assert.ok(card?.signIn);
    await page.goto(base);
    const selector = `[data-card="${card.id}"]`;
    await page.locator(`${selector} .teach-row`).click();
    await page.locator(`${selector} [data-correct="human"]`).click();
    await page.locator(`${selector} .teach-signin:not([hidden])`).waitFor();
    assert.equal(await page.locator(`${selector} [data-signin-first]`).inputValue(), before.teach.cards[0]!.id);
    assert.equal(await page.locator(`${selector} [data-signin-last]`).inputValue(), card.signIn.lastEventId);
    const confirmButton = await page.locator(`${selector} [data-signin-confirm]`).elementHandle();
    assert.ok(confirmButton);
    assert.equal(await confirmButton.evaluate((button) => button === document.activeElement), true);
    await page.waitForTimeout(1200);
    assert.equal(await confirmButton.evaluate((button) => button.isConnected && button === document.activeElement), true, "polls must not replace or blur the open confirmation");
    const next = before.teach.cards.at(-1)!;
    await post("/api/teach/correct", { kind: "rename", cardId: next.id, intent: "Open the account statement" });
    await page.waitForFunction((id) => document.querySelector(`[data-card="${id}"] .intent-read`)?.textContent === "Open the account statement", next.id);
    assert.equal(await page.locator(`${selector} [data-signin-confirm]`).evaluate((button) => button === document.activeElement), true, "a real Teach repaint must restore the stable focus key");
    const decisionsBeforeInvalid = (await state()).teach.decisions;
    const invalid = await fetch(base + "/api/teach/correct", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "human", cardId: card.id, signIn: { firstEventId: "missing", lastEventId: card.signIn.lastEventId } }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual((await state()).teach.decisions, decisionsBeforeInvalid);
    await page.locator(`${selector} [data-signin-confirm]`).click();
    await page.waitForFunction((id) => document.querySelector(`[data-card="${id}"] .intent-read`)?.textContent === "Sign in", card.id);
    const confirmed = await state();
    assert.equal(confirmed.teach.cards.filter((item) => !item.dropped && !item.merged).length, 2);
    await page.locator(`${selector} .teach-signin-steps summary`).click();
    await page.waitForTimeout(1200);
    assert.equal(await page.locator(`${selector} .teach-signin-steps`).evaluate((details) => (details as HTMLDetailsElement).open), true, "polls must keep the sign-in steps expanded");
    assert.match(await page.locator(`${selector} .teach-signin-steps`).innerText(), /Confirm password/);
    await page.locator(`${selector} [data-correct="verify"]`).click();
    await page.waitForFunction((id) => document.querySelector(`[data-card="${id}"] .badge.edited`)?.getAttribute("title")?.includes("this is a check"), card.id);
    await post("/api/teach/stop");
    const doc = await post<WorkflowV2>("/api/teach/save", { name: "Owner completes every sign-in screen" });
    assert.deepEqual(doc.inputs, []);
    assert.deepEqual(doc.steps.map((step) => step.action), ["handoff", "click"]);
    assert.equal(doc.steps[0]?.action === "handoff" ? doc.steps[0].actor : undefined, "owner");
    assert.deepEqual(doc.steps[0]?.action === "handoff" ? doc.steps[0].check : undefined, { kind: "text", match: "Account overview", timeoutMs: 15000 });
    const trail = app.library.readTrail(doc.id) as TrailEvent[];
    assert.ok(trail.some((event) => event.identity?.id === "confirm-password"));
    assert.ok(trail.some((event) => event.op === "key" && event.key === "Enter"));
    assert.ok(trail.some((event) => event.op === "check"));
    assert.ok(trail.some((event) => event.afterUrl?.endsWith("/challenge")));
    assert.deepEqual(trail.find((event) => event.kind === "decision" && event.decision === "human")?.signIn, {
      firstEventId: card.signIn.firstEventId, lastEventId: card.signIn.lastEventId,
    });

    const pending = post<{ status: string; failure?: unknown }>("/api/replay", { id: doc.id, args: { password: "never-autofill-this", code: "999999" } }).catch((error: unknown) => ({ status: "request-failed", failure: String(error) }));
    const waitStarted = Date.now();
    let ready = false;
    while (Date.now() - waitStarted < 12000) {
      const current = await state();
      if (current.activeAsk?.kind === "login") {
        const shot = await fetch(base + "/api/replay/shot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: doc.id, file: "signin-ready.png" }) });
        if (shot.ok) { ready = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "owner handoff and replay page should both be ready");
    for (const action of [
      { fill: { selector: "#username", value: "owner-replay" } },
      { fill: { selector: "#password", value: "owner-password" } },
      { click: "#signin" },
    ]) await post("/api/replay/drive", { id: doc.id, ...action });
    assert.equal((await state()).activeAsk?.kind, "login", "the intermediate submit must not finish the handoff");
    for (const action of [
      { fill: { selector: "#confirm-password", value: "owner-password" } },
      { fill: { selector: "#pin", value: "654321" } },
      { click: "#verify" },
    ]) await post("/api/replay/drive", { id: doc.id, ...action });
    const run = await pending;
    assert.equal(run.status, "passed", JSON.stringify(run.failure));
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
