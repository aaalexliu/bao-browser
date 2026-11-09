import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { captureStream, captureView, recordBar, type ShellState, type TeachView } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";

type CaptureTestState = ShellState & {
  capture: NonNullable<ShellState["capture"]>;
  teach: TeachView & { review: NonNullable<TeachView["review"]> };
};

test("capture renders the recording name, ordered stream, controls and paused state", () => {
  const state = { recording: true, capture: { recording: true, paused: false, url: "https://example.com", steps: ["Open https://example.com", 'Click <Next>'], stream: [{ label: "Open https://example.com", op: "navigate" }, { label: 'Click <Next>', op: "click" }] } };
  const html = captureView(state, { name: 'A "named" task', startUrl: "/fixture", error: "", busy: false, picking: true });
  assert.match(html, /value="A &quot;named&quot; task"/);
  assert.match(html, /Recording in Bao’s Chrome · example.com/);
  assert.match(html, /aria-label="Recorded steps"/);
  assert.match(html, /Click &lt;Next&gt;/);
  assert.match(html, /Pick list is on/);
  assert.match(html, /Discard…/);
  assert.match(html, /Stop and save/);
  assert.doesNotMatch(html, /Mac app|Agent and MCP|Trail|thumb/);
  assert.match(captureStream({ ...state, capturePaused: true }), /Recording is paused/);
  assert.match(recordBar(state, true, true), /aria-pressed="true"/);
  assert.match(recordBar({ ...state, capturePaused: true }, true), /Resume/);
  assert.equal(recordBar({}, true), "");
});

test("capture routes a pending Teach review back to Teach without changing its steps", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-capture-teach-review-"));
  const oldHome = process.env.HOME;
  const oldDrive = process.env.BAO_DRIVE;
  process.env.HOME = home;
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const url = `http://127.0.0.1:${app.port}`;
  const getState = async () => (await page.request.get(`${url}/api/state`)).json() as Promise<CaptureTestState>;
  try {
    await page.goto(url);
    await page.locator(".runs-record").click();
    await page.getByRole("button", { name: "Teach", exact: true }).click();
    await page.locator("#teach-url").fill(`${url}/fixture`);
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${url}/api/sessions` && response.request().method() === "POST").then((response) => response.finished()),
      page.locator("#teach-start").click(),
    ]);
    await page.locator("#teach-stop").waitFor();
    const action = await page.request.post(`${url}/api/sessions/drive`, { data: { click: "#apply-btn" } });
    assert.equal(action.ok(), true, await action.text());
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${url}/api/teach/stop`).then((response) => response.finished()),
      page.locator("#teach-stop").click(),
    ]);
    await page.locator("#teach-review").waitFor();
    const pending = (await getState()).teach;
    assert.equal(pending.phase, "review");
    assert.ok(pending.review.workflow.steps.length > 0);
    await page.locator("#rail [data-place=workflows]").click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByText("Save or discard your pending Teach review before starting a capture.", { exact: true }).waitFor();
    assert.equal(await page.locator("#start, #stop, #capture-discard, #record-bar").count(), 0);
    const current = await getState();
    assert.equal(current.recording, false);
    assert.equal(current.teach.phase, "review");
    assert.deepEqual(current.teach.review, pending.review);
    await page.getByRole("button", { name: "Teach", exact: true }).click();
    await page.locator("#teach-review").waitFor();
    assert.equal(await page.locator("#teach-save").isVisible(), true);
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldDrive === undefined) delete process.env.BAO_DRIVE; else process.env.BAO_DRIVE = oldDrive;
    await rm(home, { recursive: true, force: true });
  }
});

test("an empty Teach review can be discarded from capture to allow a new recording", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-capture-empty-teach-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const url = `http://127.0.0.1:${app.port}`;
  const getState = async () => (await page.request.get(`${url}/api/state`)).json() as Promise<CaptureTestState>;
  try {
    await page.goto(url);
    await page.locator(".runs-record").click();
    await page.getByRole("button", { name: "Teach", exact: true }).click();
    await page.locator("#teach-url").fill(`${url}/fixture`);
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${url}/api/sessions` && response.request().method() === "POST").then((response) => response.finished()),
      page.locator("#teach-start").click(),
    ]);
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${url}/api/teach/stop`).then((response) => response.finished()),
      page.locator("#teach-stop").click(),
    ]);
    await page.locator("#teach-review").waitFor();
    const pending = (await getState()).teach;
    assert.equal(pending.phase, "review");
    assert.equal(pending.review.workflow.steps.length, 0);
    await page.locator("#rail [data-place=workflows]").click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    const discard = page.getByRole("button", { name: "Discard Teach review", exact: true });
    page.once("dialog", (dialog) => void dialog.dismiss());
    await discard.click();
    assert.deepEqual((await getState()).teach.review, pending.review);
    assert.equal(await page.locator("#start").count(), 0);
    await page.route("**/api/teach/discard", (route) => route.fulfill({ status: 500, json: { error: "Fixture discard failed" } }));
    page.once("dialog", (dialog) => void dialog.accept());
    await discard.click();
    await page.getByRole("alert").filter({ hasText: "Fixture discard failed" }).waitFor();
    assert.equal((await getState()).teach.phase, "review");
    assert.equal(await page.locator("#start").count(), 0);
    await page.unroute("**/api/teach/discard");
    page.once("dialog", (dialog) => void dialog.accept());
    await discard.click();
    await page.locator("#start:not([disabled])").waitFor();
    assert.equal((await getState()).teach.phase, "idle");
    assert.equal(await discard.count(), 0);
    assert.equal(app.library.list().workflows.length, 0);
    await page.locator("#start-url").fill(`${url}/fixture`);
    await Promise.all([
      page.waitForResponse((response) => response.url() === `${url}/api/sessions` && response.request().method() === "POST", { timeout: 30_000 }).then((response) => response.finished()),
      page.locator("#start").click(),
    ]);
    await page.locator("#stop:not([disabled])").waitFor();
    const recording = await getState();
    assert.equal(recording.recording, true);
    assert.equal(recording.teach.phase, "idle");
    assert.ok(recording.capture.steps.length > 0);
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("offscreen capture saves keep the typed name and clear drafts after save or discard", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-capture-offscreen-save-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const url = `http://127.0.0.1:${app.port}`;
  const openScreen = async (screen: "capture" | "runs") => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator("#palette-input").fill(screen);
    await page.locator(`#palette-list [data-command="${screen}"]`).click();
  };
  try {
    await page.goto(url);
    for (const outcome of ["save", "discard"] as const) {
      await openScreen("capture");
      assert.equal(await page.locator("#cap-name").inputValue(), "");
      const name = outcome === "save" ? "Pay bill" : "Do not save this task";
      await page.locator("#cap-name").fill(name);
      await page.locator("#start-url").fill(`${url}/fixture`);
      await page.locator("#start").click();
      await page.locator("#stop:not([disabled])").waitFor();
      await openScreen("runs");
      assert.equal(await page.locator("#capture-panel").count(), 0);
      await page.locator("#rec-stop").click();
      await page.locator("#save-title").waitFor();
      assert.equal(await page.locator("#save-title").inputValue(), name);
      if (outcome === "save") {
        await page.locator("#save-title").fill("Pay bill edited");
        await page.locator("#save-commit").click();
        await page.locator("#workflow-detail").waitFor();
        assert.deepEqual(app.library.list().workflows.map((workflow) => workflow.name), ["Pay bill edited"]);
      } else {
        await page.locator("#save-discard").click();
        await page.locator("#save-sheet").waitFor({ state: "hidden" });
        assert.deepEqual(app.library.list().workflows.map((workflow) => workflow.name), ["Pay bill edited"]);
      }
      await openScreen("capture");
      assert.equal(await page.locator("#cap-name").inputValue(), "");
      assert.equal(await page.locator("#capture-error").isHidden(), true);
    }
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("the running capture saves its name and steps, pauses, recovers errors and discards", { timeout: 90_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-capture-ui-"));
  const oldHome = process.env.HOME;
  const oldDrive = process.env.BAO_DRIVE;
  process.env.HOME = home;
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
  page.setDefaultTimeout(10_000);
  const url = `http://127.0.0.1:${app.port}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const getState = async () => (await page.request.get(`${url}/api/state`)).json() as Promise<CaptureTestState>;
  try {
    await page.goto(url);
    await page.locator(".runs-record").click();
    await page.locator("#cap-name").fill("Read local notes");
    await page.route("**/api/sessions", (route) => route.fulfill({ status: 500, json: { error: "Fixture start failed" } }));
    await page.locator("#start").click();
    await page.getByRole("alert").filter({ hasText: "Fixture start failed" }).waitFor();
    assert.equal(await page.locator("#cap-name").inputValue(), "Read local notes");
    await page.unroute("**/api/sessions");
    await page.locator("#start").click();
    await page.getByRole("heading", { name: "Recording", exact: true }).waitFor();
    await page.locator("#stop:not([disabled])").waitFor();
    assert.equal(await page.locator("#rail").isVisible(), false);
    assert.equal((await getState()).recording, true);
    const drive = async (body: object) => {
      const response = await page.request.post(`${url}/api/sessions/drive`, { data: body });
      assert.equal(response.ok(), true, await response.text());
    };
    await drive({ fill: { selector: "#note-input", value: "local test" } });
    await drive({ click: "#save-note" });
    await page.waitForFunction(() => document.querySelectorAll(".stream li:not(.wait)").length >= 3);
    assert.match(await page.locator(".stream").innerText(), /Click Save note/);
    await page.locator("#cap-name").fill("Export local notes");
    await page.locator("#rec-pause").click();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    assert.equal((await getState()).capturePaused, true);
    assert.equal(await page.locator("#cap-name").inputValue(), "Export local notes");
    const before = (await getState()).capture.steps.length;
    await drive({ click: "#apply-btn" });
    assert.equal((await getState()).capture.steps.length, before);
    await page.locator("#rec-pause").click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.locator("#rec-pause").click();
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      for (const width of [1280, 400, 360, 320]) {
        await page.setViewportSize({ width, height: 700 });
        const layout = await page.evaluate(() => {
          const footer = document.querySelector(".cap-foot")?.getBoundingClientRect();
          const toolbar = document.querySelector(".capture-controls")?.getBoundingClientRect();
          return {
            fitsViewport: document.documentElement.scrollWidth <= innerWidth,
            controlsSeparated: Boolean(footer && toolbar && footer.bottom <= toolbar.top),
          };
        });
        assert.equal(layout.fitsViewport, true);
        assert.equal(layout.controlsSeparated, true, `Controls overlap at ${width}px`);
        for (const button of await page.locator(".cap-foot button, .capture-controls button").all()) await button.click({ trial: true });
      }
    }
    await page.locator("#stop").click();
    await page.locator("#workflow-detail").waitFor();
    const saved = app.library.list().workflows.find((workflow) => workflow.name === "Export local notes");
    assert.ok(saved, "Stop and save stores the entered name");
    assert.ok(saved.steps.some((step) => step.action === "click"));
    assert.equal((await getState()).recording, false);
    assert.equal((await getState()).saveSheet, null);
    await page.locator('#workflow-detail [data-screen="capture"]').click();
    await page.locator("#cap-name").fill("Recover saved name");
    await page.locator("#start").click();
    await page.locator("#capture-discard:not([disabled])").waitFor();
    await page.route("**/api/sessions/commit", (route) => route.fulfill({ status: 500, json: { error: "Fixture save failed" } }));
    await page.locator("#stop").click();
    await page.locator("#save-title").waitFor();
    assert.equal(await page.locator("#save-title").inputValue(), "Recover saved name");
    await page.unroute("**/api/sessions/commit");
    await page.locator("#save-commit").click();
    await page.locator("#workflow-detail").waitFor();
    assert.ok(app.library.list().workflows.some((workflow) => workflow.name === "Recover saved name"));
    await page.locator('#workflow-detail [data-screen="capture"]').click();
    await page.locator("#start").click();
    await page.locator("#capture-discard:not([disabled])").waitFor();
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.locator("#capture-discard").click();
    assert.equal((await getState()).recording, true);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("#capture-discard").click();
    await page.locator("#library").waitFor();
    assert.equal((await getState()).recording, false);
    assert.equal(app.library.list().workflows.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldDrive === undefined) delete process.env.BAO_DRIVE; else process.env.BAO_DRIVE = oldDrive;
    await rm(home, { recursive: true, force: true });
  }
});
