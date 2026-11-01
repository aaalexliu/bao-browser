// The pinned test Chromium on a throwaway profile under tmp. This does not read a daily Chrome profile.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { pinTestBrowser } from "../../src/launch";
import { TEST_MEDIA_ARGS } from "../../src/test-browser.js";
import { Library } from "../../src/v1/store";

interface LiveBody {
  outcome?: { kind?: string; reason?: string };
  session?: string;
  view?: {
    controls: { ref: string; label: string }[];
    credentialFields: number;
    stopBeforeConfirm: { label: string }[];
    path?: string;
  } | null;
}

function shopHtml(other: string): string {
  return `<!doctype html><title>Shop</title>
<button type="button" id="add">Add to cart</button>
<button type="button" id="place">Place your order</button>
<form role="search"><input type="search" name="q" aria-label="Search"><button type="submit">Place order</button></form>
<button type="button" id="delete">Delete account</button>
<a href="/account-settings">Account settings</a>
<a href="/payment">Payment</a>
<a id="off" href="${other}/off">Off host</a>
<button type="button" id="leave">Leave</button>
<div style="position:relative;width:140px;height:44px">
  <a id="details" href="#details" style="display:block;width:140px;height:44px">Details</a>
  <div id="cover" style="position:absolute;inset:0"></div>
</div>
<label>Instructions <input id="instructions" name="instructions" aria-label="Instructions"></label>
<label>Note <input id="note" name="note" aria-label="Note"></label>
<p id="count">0</p>
<script>
const cover = document.getElementById("cover");
const root = cover.attachShadow({ mode: "open" });
const shadow = document.createElement("button");
shadow.textContent = "Place order";
shadow.style.cssText = "width:140px;height:44px";
shadow.onclick = () => fetch("/effect?name=place-shadow");
root.appendChild(shadow);
const count = document.getElementById("count");
document.getElementById("add").onclick = () => { fetch("/effect?name=added"); count.textContent = String(Number(count.textContent) + 1); };
document.getElementById("place").onclick = () => fetch("/effect?name=ordered");
document.querySelector("form").onsubmit = (event) => { event.preventDefault(); fetch("/effect?name=search-ordered"); };
document.getElementById("delete").onclick = () => fetch("/effect?name=deleted");
document.getElementById("leave").onclick = () => { location.href = ${JSON.stringify(other + "/landed")}; };
const instructions = document.getElementById("instructions");
instructions.addEventListener("input", () => fetch("/effect?name=typed-" + encodeURIComponent(instructions.value)));
const holder = document.createElement("div");
document.body.appendChild(holder);
const closed = holder.attachShadow({ mode: "closed" });
const secret = document.createElement("input");
secret.type = "password";
secret.addEventListener("input", () => fetch("/effect?name=secret-" + encodeURIComponent(secret.value)));
closed.appendChild(secret);
document.getElementById("note").addEventListener("focus", () => secret.focus());
</script>`;
}

function page(title: string, body: string): string {
  return `<!doctype html><title>${title}</title>${body}`;
}

async function listen(handler: (url: string, hits: string[]) => string | null): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url || "/";
    hits.push(url);
    const body = handler(url, hits);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function killChrome(child: ChildProcess | undefined, userData: string): void {
  if (child && child.pid && !child.killed) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  spawnSync("pkill", ["-9", "-f", `user-data-dir=${userData}`]);
}

async function waitForPort(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      if (/^\d+\n\/devtools\/browser\//.test(text)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DevToolsActivePort was not written");
}

test("live fixture refuses the reviewed traps, then replays a shop with no model call", { skip: process.env.BAO_LIVE_TESTS !== "1", timeout: 240_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-live-fixture-"));
  const userData = path.join(root, "chrome");
  const other = await listen(() => "off");
  const shop = await listen((url) => {
    const pathName = url.split("?")[0] || "/";
    if (pathName === "/shop") return shopHtml(`${other.origin}`);
    if (pathName === "/checkout") return page("Checkout", "<button type='button'>Place your order</button>");
    if (pathName === "/captcha") return page("Captcha", "<p>I'm not a robot</p><button type='button' id='robot'>I'm not a robot</button><script>document.getElementById('robot').onclick=()=>fetch('/effect?name=robot')</script>");
    if (pathName === "/sso") return page("SSO", "<button type='button' id='google'>Continue with Google</button><script>document.getElementById('google').onclick=()=>fetch('/effect?name=sso')</script>");
    if (pathName === "/bot") return page("Bot", "<p>Request unsuccessful. Powered by Imperva</p><button type='button' id='retry'>Retry</button><script>document.getElementById('retry').onclick=()=>fetch('/effect?name=retry')</script>");
    if (pathName === "/2fa") return page("2FA", "<label>Verification code <input name='code' aria-label='Verification code'></label><button type='button' id='verify'>Verify</button><script>document.getElementById('verify').onclick=()=>fetch('/effect?name=verified')</script>");
    if (pathName === "/signedin") return page("Signed in", "<p>Signed in</p><form hidden><input type='password' name='password'></form>");
    if (pathName === "/visible-password") return page("Profile", "<label>Password <input type='password' name='password'></label>");
    return "ok";
  });
  const host = createLiveHost({
    home: root,
    lockFile: path.join(root, "lock"),
    connectTimeoutMs: 30_000,
    // The replay drives the host's target, so it is this throwaway Chrome too.
    target: { kind: "throwaway", portFile: path.join(userData, "DevToolsActivePort") },
  });
  let chrome: ChildProcess | undefined;
  try {
    chrome = spawn(pinTestBrowser(), [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      ...TEST_MEDIA_ARGS,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ], { stdio: "ignore" });
    const portFile = path.join(userData, "DevToolsActivePort");
    const early = await host.call({
      op: "live_session_start",
      intent: "Shop",
      url: `${shop.origin}/checkout`,
      portFile,
      preset: "generic",
    }) as LiveBody;
    assert.equal(early.outcome?.reason, "stop-path");
    assert.equal(shop.hits.some((hit) => hit.startsWith("/checkout")), false);
    await waitForPort(portFile);
    const call = (body: Record<string, unknown>) => host.call({ ...body, portFile }) as Promise<LiveBody>;
    // A Chrome started with --remote-debugging-port has no Allow dialog, so BaoOSHelper is not needed.
    const opened = await call({
      op: "live_session_start",
      intent: "Shop the fixture",
      url: `${shop.origin}/shop`,
      preset: "generic",
      workflowId: "wf-shop-fixture",
    });
    assert.equal(opened.outcome?.kind, "applied", JSON.stringify(opened.outcome));
    const labels = (opened.view?.controls || []).map((item) => item.label);
    assert.equal(labels.includes("Place your order"), false);
    assert.equal(labels.includes("Place order"), false);
    assert.equal(labels.includes("Delete account"), false);
    assert.equal((opened.view?.stopBeforeConfirm || []).some((item) => /place|delete/i.test(item.label)), true);
    const epoch = opened.view?.controls[0]?.ref.split(".")[0] || "e1";
    for (let index = 0; index < 16; index += 1) {
      const ref = `${epoch}.c${index}`;
      if ((opened.view?.controls || []).some((item) => item.ref === ref)) continue;
      const probed = await host.call({ op: "live_click", ref }) as LiveBody;
      assert.notEqual(probed.outcome?.kind, "applied", ref);
    }
    const clickLabel = async (label: string): Promise<LiveBody> => {
      const ref = opened.view?.controls.find((item) => item.label === label)?.ref || "";
      assert.ok(ref, label);
      return host.call({ op: "live_click", ref }) as Promise<LiveBody>;
    };
    const settings = await clickLabel("Account settings");
    assert.equal(settings.outcome?.kind, "refused");
    assert.equal(settings.outcome?.reason, "stop-path");
    const payment = await clickLabel("Payment");
    assert.equal(payment.outcome?.reason, "stop-path");
    const off = await clickLabel("Off host");
    assert.notEqual(off.outcome?.kind, "applied");
    const details = await clickLabel("Details");
    assert.equal(details.outcome?.reason, "element is covered");
    assert.equal(other.hits.some((hit) => hit.startsWith("/off") || hit.startsWith("/landed")), false);
    const added = await clickLabel("Add to cart");
    assert.equal(added.outcome?.kind, "applied", JSON.stringify(added.outcome));
    const field = added.view?.controls.find((item) => item.label === "Instructions")?.ref
      || opened.view?.controls.find((item) => item.label === "Instructions")?.ref
      || "";
    assert.ok(field);
    const typed = await host.call({ op: "live_type", ref: field, text: "milk" }) as LiveBody;
    assert.equal(typed.outcome?.kind, "applied", JSON.stringify(typed.outcome));
    const note = typed.view?.controls.find((item) => item.label === "Note")?.ref || "";
    assert.ok(note);
    const stolen = await host.call({ op: "live_type", ref: note, text: "hunter2" }) as LiveBody;
    assert.equal(stolen.outcome?.kind, "halted", JSON.stringify(stolen.outcome));
    const stopped = await host.call({ op: "live_stop" }) as LiveBody;
    assert.equal(stopped.outcome?.kind, "stopped");
    const session = JSON.parse(readFileSync(path.join(root, "live-session", "session.json"), "utf8")) as { status?: string; audit?: { action?: string }[] };
    assert.notEqual(session.status, "passed");
    assert.equal((session.audit || []).some((row) => row.action === "click"), true);
    const library = new Library(root);
    const workflow = library.read("wf-shop-fixture");
    assert.equal(workflow.driver, "cdp-live");
    assert.deepEqual(workflow.steps.map((step) => step.action), ["click", "type"]);
    assert.equal(workflow.steps.some((step) => step.human === true), false);
    assert.deepEqual(workflow.inputs.map((input) => [input.name, input.default]), [["instructions", "milk"]]);
    assert.equal(workflow.steps[1]?.value, "{{instructions}}");
    const first = await host.replay(workflow);
    const second = await host.replay(workflow);
    assert.equal(first.status, "passed", JSON.stringify(first.failure));
    assert.equal(second.status, "passed", JSON.stringify(second.failure));
    assert.equal(first.modelCalls, 0);
    assert.equal(second.modelCalls, 0);
    const effects = () => shop.hits.filter((hit) => hit.startsWith("/effect"));
    const count = (name: string) => effects().filter((hit) => hit.includes(`name=${encodeURIComponent(name)}`) || hit.includes(`name=${name}`)).length;
    assert.equal(count("ordered"), 0);
    assert.equal(count("search-ordered"), 0);
    assert.equal(count("deleted"), 0);
    assert.equal(count("place-shadow"), 0);
    assert.equal(count("secret-hunter2"), 0);
    assert.equal(count("added"), 3);
    assert.equal(count("typed-milk"), 3, "each replay types the recorded text");
    assert.equal(shop.hits.some((hit) => hit.startsWith("/account-settings")), false);
    assert.equal(shop.hits.some((hit) => hit.startsWith("/payment")), false);
    assert.equal(shop.hits.some((hit) => hit.startsWith("/checkout")), false);

    const again = await call({
      op: "live_session_start",
      intent: "Leave the shop",
      url: `${shop.origin}/shop`,
      preset: "generic",
    });
    assert.equal(again.outcome?.kind, "applied", JSON.stringify(again.outcome));
    const leaveRef = again.view?.controls.find((item) => item.label === "Leave")?.ref || "";
    assert.ok(leaveRef);
    const leave = await host.call({ op: "live_click", ref: leaveRef }) as LiveBody;
    assert.notEqual(leave.outcome?.kind, "applied", JSON.stringify(leave.outcome));
    assert.equal(other.hits.some((hit) => hit.startsWith("/off") || hit.startsWith("/landed")), false);
    await host.call({ op: "live_stop" });

    const captcha = await call({ op: "live_session_start", intent: "Captcha", url: `${shop.origin}/captcha`, preset: "generic" });
    assert.equal(captcha.outcome?.kind, "halted", JSON.stringify(captcha.outcome));
    assert.equal(captcha.outcome?.reason, "bot_wall");
    const robot = await host.call({ op: "live_click", ref: "e1.c0" }) as LiveBody;
    assert.equal(robot.outcome?.kind, "halted");
    await host.call({ op: "live_stop" });
    const sso = await call({ op: "live_session_start", intent: "SSO", url: `${shop.origin}/sso`, preset: "generic" });
    assert.equal(sso.outcome?.reason, "login_wall", JSON.stringify(sso.outcome));
    await host.call({ op: "live_stop" });
    const bot = await call({ op: "live_session_start", intent: "Bot", url: `${shop.origin}/bot`, preset: "generic" });
    assert.equal(bot.outcome?.reason, "bot_wall", JSON.stringify(bot.outcome));
    await host.call({ op: "live_stop" });
    const twofa = await call({ op: "live_session_start", intent: "Two factor", url: `${shop.origin}/2fa`, preset: "generic" });
    assert.equal(twofa.outcome?.kind, "halted", JSON.stringify(twofa.outcome));
    await host.call({ op: "live_stop" });
    const signed = await call({ op: "live_session_start", intent: "Signed in", url: `${shop.origin}/signedin`, preset: "generic" });
    assert.equal(signed.outcome?.kind, "applied", JSON.stringify(signed.outcome));
    assert.equal(signed.view?.credentialFields, 0);
    await host.call({ op: "live_stop" });
    const visible = await call({ op: "live_session_start", intent: "Visible password", url: `${shop.origin}/visible-password`, preset: "generic" });
    assert.equal(visible.outcome?.kind, "applied", JSON.stringify(visible.outcome));
    assert.equal((visible.view?.credentialFields || 0) > 0, true);
    assert.equal((visible.view?.controls || []).some((item) => item.label === "Password"), false);
    await host.call({ op: "live_stop" });
    assert.equal(count("robot") + count("sso") + count("retry") + count("verified"), 0);
  } finally {
    await host.close().catch(() => undefined);
    killChrome(chrome, userData);
    await shop.close();
    await other.close();
  }
});
