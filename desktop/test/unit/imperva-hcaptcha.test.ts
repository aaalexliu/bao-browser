import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { isImpervaHcaptcha } from "../../src/cdp-live/bot-check";
import { pageHalt } from "../../src/cdp-live/live-ops";
import { READER_HELPERS, readInstacart, type InstacartSnap } from "../../src/cdp-live/instacart";
import { launchOwnedChrome, pinTestBrowser } from "../../src/launch";
import { applyHermeticApp } from "../runtime";

type Reply = {
  session: string;
  outcome: { kind: string; reason?: string };
  view: { controls: { label: string; ref?: string }[] };
};

test("Imperva outer challenge frames do not require a parent widget", () => {
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?SWUDNSAI=31&incident_id=fixture"]), true);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?CWUDNSAI=1"]), true);
  assert.equal(isImpervaHcaptcha([]), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?SWJIYLWA=sensor"]), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?d=sensor"]), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?SWCGHOEL=v2"]), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/article?title=_Incapsula_Resource&SWUDNSAI=31"]), false);
  assert.equal(isImpervaHcaptcha(["invalid url"]), false);
  assert.equal(pageHalt({ blocked: "bot_wall", path: "/", passwordFields: 0, text: "One more step" }), "bot_wall");
});

test("HTTP 200 Imperva hCaptcha stops live mode for the owner without input", { timeout: 90_000 }, async (t) => {
  const dirs = applyHermeticApp("imperva-hcaptcha");
  pinTestBrowser();
  const fixture = readFileSync(path.join(process.cwd(), "desktop/test/fixtures/imperva-hcaptcha.html"), "utf8");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url || "/");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/_Incapsula_Resource")) {
      if (/[?&](?:SWUDNSAI|CWUDNSAI)=/.test(req.url)) return res.end('<div class="h-captcha" data-sitekey="fixture-site-key"><iframe src="/widget" title="Widget"></iframe></div>');
      res.setHeader("content-type", "text/javascript");
      return res.end("");
    }
    if (req.url === "/widget") return res.end('<form action="/challenge-submit"><button onclick="fetch(\'/challenge-click\')">Continue</button><input aria-label="Response" oninput="fetch(\'/challenge-input\')"></form>');
    if (req.url === "/signup") return res.end('<title>Join us</title><h1>Create account</h1><form><label>Name<input></label><div class="h-captcha" data-sitekey="signup"><iframe src="/widget" title="Security check"></iframe></div><button>Join</button></form><script src="/_Incapsula_Resource?d=sensor"></script><script src="/_Incapsula_Resource?SWJIYLWA=sensor"></script>');
    return res.end(req.url === "/?legacy=1" ? fixture.replace("SWUDNSAI", "CWUDNSAI") : fixture);
  });
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>> | undefined;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path.dirname(dirs.home), { recursive: true, force: true });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  const page = browser.pages()[0] || await browser.newPage();
  const response = await page.goto(url);
  assert.equal(response?.status(), 200);
  const readStore = () => page.evaluate<InstacartSnap>(`(() => { ${READER_HELPERS.map((helper) => `const ${helper.name} = ${helper.toString()};`).join("\n")} return (${readInstacart.toString()})(""); })()`);

  for (const [parameter, careful] of [["SWUDNSAI", true], ["SWUDNSAI", false], ["CWUDNSAI", true], ["CWUDNSAI", false]] as const) {
    const startUrl = parameter === "CWUDNSAI" ? url + "/?legacy=1" : url;
    await page.goto(startUrl);
    assert.equal((await readStore()).blocked, "captcha");
    const home = path.join(dirs.home, parameter, String(careful));
    const host = createLiveHost({ home, target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") }, lockFile: path.join(dirs.home, "live.lock"), idleMs: 0 });
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      const started = await call({ op: "live_session_start", careful, intent: "Read local report", url: startUrl });
      assert.deepEqual(started.outcome, { kind: "halted", reason: "bot_wall" });
      for (const body of [
        { op: "live_click", ref: "e1.c0" },
        { op: "live_type", ref: "e1.c0", text: "do not enter" },
        { op: "live_key", key: "Enter" },
      ]) assert.deepEqual((await call(body)).outcome, { kind: "halted", reason: "bot_wall" });
      const challenge: Page | undefined = browser.pages().filter((item) => item.url() === (parameter === "CWUDNSAI" ? startUrl : url + "/") && item !== page).at(-1);
      assert.ok(challenge);
      assert.deepEqual(await challenge.evaluate("window.challengeEvents"), []);
      assert.equal(await challenge.frameLocator("iframe").frameLocator("iframe").getByLabel("Response").inputValue(), "");
      await call({ op: "live_stop" });
    } finally {
      await host.close();
    }
  }
  await page.goto(url + "/signup");
  assert.equal((await readStore()).blocked, null);
  const home = path.join(dirs.home, "signup");
  const host = createLiveHost({ home, target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") }, lockFile: path.join(dirs.home, "live.lock"), idleMs: 0 });
  try {
    const signup = await host.call({ op: "live_session_start", careful: true, intent: "Read local form", url: url + "/signup" }) as Reply;
    assert.equal(signup.outcome.kind, "applied");
    assert.ok(signup.view.controls.some((control) => control.label === "Name" && control.ref));
    await host.call({ op: "live_stop" });
  } finally {
    await host.close();
  }
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <iframe src="${url}/_Incapsula_Resource?CWUDNSAI=1"></iframe>`);
  assert.equal((await readStore()).blocked, "captcha");
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <script src="${url}/_Incapsula_Resource?CWUDNSAI=1"></script>
    <div class="h-captcha" data-sitekey="signup"></div>
    <iframe src="https://newassets.hcaptcha.com/captcha/v1/fixture/hcaptcha.html"></iframe>`);
  assert.equal((await readStore()).blocked, null);
  assert.ok(requests.includes("/_Incapsula_Resource?SWUDNSAI=31&incident_id=fixture"));
  assert.ok(requests.includes("/_Incapsula_Resource?CWUDNSAI=31&incident_id=fixture"));
  assert.ok(requests.includes("/widget"));
  assert.equal(requests.some((request) => request.startsWith("/challenge-")), false);
});
