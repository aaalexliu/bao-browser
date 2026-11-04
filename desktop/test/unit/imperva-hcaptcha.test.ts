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

test("Imperva hCaptcha requires challenge structure, not a normal widget or sensor", () => {
  const challenge = "https://fixture.test/_Incapsula_Resource?SWCGHOEL=v2";
  const wrapper = "https://fixture.test/_Incapsula_Resource?CWUDNSAI=1";
  assert.equal(isImpervaHcaptcha([challenge], true), true);
  assert.equal(isImpervaHcaptcha([wrapper], true), true);
  assert.equal(isImpervaHcaptcha([challenge], false), false);
  assert.equal(isImpervaHcaptcha([], true), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/_Incapsula_Resource?d=sensor"], true), false);
  assert.equal(isImpervaHcaptcha(["https://fixture.test/article?title=_Incapsula_Resource&SWCGHOEL=v2"], true), false);
  assert.equal(isImpervaHcaptcha(["invalid url"], true), false);
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
      res.setHeader("content-type", "text/javascript");
      return res.end("");
    }
    if (req.url === "/widget") return res.end('<form action="/challenge-submit"><button onclick="fetch(\'/challenge-click\')">Continue</button><input aria-label="Response" oninput="fetch(\'/challenge-input\')"></form>');
    if (req.url === "/signup") return res.end('<title>Join us</title><h1>Create account</h1><form><label>Name<input></label><div class="h-captcha" data-sitekey="signup"><iframe src="/widget" title="Security check"></iframe></div><button>Join</button></form><script src="/_Incapsula_Resource?d=sensor"></script>');
    return res.end(fixture);
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

  for (const careful of [true, false]) {
    const home = path.join(dirs.home, String(careful));
    const host = createLiveHost({ home, target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") }, lockFile: path.join(dirs.home, "live.lock"), idleMs: 0 });
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
    try {
      const started = await call({ op: "live_session_start", careful, intent: "Read local report", url });
      assert.deepEqual(started.outcome, { kind: "halted", reason: "bot_wall" });
      for (const body of [
        { op: "live_click", ref: "e1.c0" },
        { op: "live_type", ref: "e1.c0", text: "do not enter" },
        { op: "live_key", key: "Enter" },
      ]) assert.deepEqual((await call(body)).outcome, { kind: "halted", reason: "bot_wall" });
      const challenge: Page | undefined = browser.pages().filter((item) => item.url() === url + "/" && item !== page).at(-1);
      assert.ok(challenge);
      assert.deepEqual(await challenge.evaluate("window.challengeEvents"), []);
      assert.equal(await challenge.frameLocator("iframe").getByLabel("Response").inputValue(), "");
      await call({ op: "live_stop" });
    } finally {
      await host.close();
    }
  }
  assert.equal((await readStore()).blocked, "captcha");
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
  // CSP keeps the iframe-shaped case structural only: no hCaptcha host receives a request.
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <script src="${url}/_Incapsula_Resource?CWUDNSAI=1"></script>
    <iframe src="https://newassets.hcaptcha.com/captcha/v1/fixture/hcaptcha.html"></iframe>`);
  assert.equal((await readStore()).blocked, "captcha");
  assert.ok(requests.includes("/_Incapsula_Resource?SWCGHOEL=v2"));
  assert.ok(requests.includes("/widget"));
  assert.equal(requests.some((request) => request.startsWith("/challenge-")), false);
});
