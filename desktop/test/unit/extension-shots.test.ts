import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import { shotFormat } from "../../src/v1/shots";
import { applyHermeticApp } from "../runtime";

test("an extension Library run saves six rapid page pictures without a captureVisibleTab rate limit", { timeout: 90_000 }, async (t) => {
  const started = Date.now();
  const stage = (label: string) => t.diagnostic(`${label} after ${Date.now() - started}ms`);
  const dirs = applyHermeticApp("ext-shots");
  const root = path.dirname(dirs.home);
  const extension = path.join(root, "extension");
  const profile = path.join(root, "profile");
  mkdirSync(profile, { recursive: true });
  execFileSync(process.execPath, [path.resolve("extension/build.mjs"), extension], { stdio: "pipe" });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Only this throwaway extension gets a grant at install, so the fixture needs no permission click.
  manifest.host_permissions = ["http://*/*"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const app = await startApp({ home: dirs.home, extensionHost: true, extensionConfigHome: dirs.nativeHostHome,
    extensionHostDirs: [path.join(profile, "NativeMessagingHosts")] });
  stage("app ready");
  let context: BrowserContext | undefined;
  try {
    context = await testChromium.launchPersistentContext(profile, {
      headless: true, channel: "chromium", ignoreDefaultArgs: ["--disable-extensions"],
      env: { ...process.env, HOME: dirs.nativeHostHome, XDG_CONFIG_HOME: path.join(dirs.nativeHostHome, ".config") },
      args: ["--use-mock-keychain", "--password-store=basic", "--disable-background-networking",
        `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch"],
    });
    stage("browser launched");
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    stage("worker reported");
    // Chromium can report the worker before it creates its execution context under suite load.
    await worker.evaluate(() => true);
    stage("worker context ready");
    await app.extensionLink!.waitForHello(0, 30_000);
    stage("native hello ready");
    const base = `http://127.0.0.1:${app.port}`;
    app.library.save({ schema: "bao.workflow/v2", version: 2, id: "wf-extension-shots", name: "Rapid pictures", driver: "extension",
      startUrl: `${base}/fixture?signedin=1`, inputs: [], createdAt: 1,
      steps: [0, 1, 2].map((index) => ({ id: `picture-${index}`, index, action: "note", surface: "dom", label: `Picture ${index + 1}`, timeoutMs: 1000 })) });
    const response = await fetch(`${base}/api/replay`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "wf-extension-shots", args: {} }) });
    const result = await response.json() as { runId: string; status: string; error?: string };
    stage("replay returned");
    assert.equal(response.status, 200, result.error);
    assert.equal(result.status, "passed");
    const run = app.library.readRun(result.runId);
    const shots = path.join(dirs.home, "shots", "runs", run.id);
    assert.equal(readdirSync(shots).length, 6);
    const viewer = await context.newPage();
    for (const step of run.steps as { beforeShot?: string; afterShot?: string; beforeShotError?: string; afterShotError?: string }[]) {
      assert.equal(step.beforeShotError, undefined);
      assert.equal(step.afterShotError, undefined);
      for (const ref of [step.beforeShot, step.afterShot]) {
        assert.ok(ref);
        assert.equal(shotFormat(readFileSync(path.join(shots, ref))), "jpg");
        const picture = await viewer.goto(`${base}/api/runs/${run.id}/shots/${ref}`);
        assert.equal(picture?.headers()["content-type"], "image/jpeg");
        await viewer.waitForFunction(() => {
          const image = document.querySelector("img");
          return !!image && image.naturalWidth > 100 && image.naturalHeight > 100;
        });
      }
    }
    stage("gallery checked");
  } finally {
    stage("closing browser");
    await context?.close();
    stage("closing app");
    await app.close();
    stage("app closed");
    rmSync(root, { recursive: true, force: true });
  }
});
