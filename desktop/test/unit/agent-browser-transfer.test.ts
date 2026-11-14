import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { downloadByClick } from "../../src/engines/agent-browser-transfer";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { scaledMs } from "../runtime";

pinTestBrowser();

const JANUARY = "JANUARY-PDF\n";
const OCTOBER = "OCTOBER-PDF\n";
const REPORT = "<!doctype html><title>Report</title><p>October report</p>\n";
const FOREIGN = "<!doctype html><title>Foreign</title><p>not a file</p>\n";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function evaluate<T>(cdp: CdpSocket, targetId: string, expression: string): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result, exceptionDetails } = await cdp.send<{ result: { value: T }; exceptionDetails?: { text?: string } }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "page script failed");
    return result.value;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

function fakeCdp(handlers: {
  onEvaluate: (expression: string) => unknown;
  onCreate?: (params: Record<string, unknown>) => unknown;
  onNavigate?: (params: Record<string, unknown>) => unknown;
  targetInfo?: (targetId: string) => { browserContextId?: string };
}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp = {
    on: () => () => undefined,
    async send(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab", type: "page", url: "http://work.example/files" }] };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: params.targetId, type: "page", url: "about:blank", ...handlers.targetInfo?.(String(params.targetId)) } };
      if (method === "Target.getBrowserContexts") return { browserContextIds: ["work"], defaultBrowserContextId: "personal" };
      if (method === "Runtime.evaluate") return handlers.onEvaluate(String(params.expression ?? ""));
      if (method === "Target.createTarget") return handlers.onCreate?.(params) ?? { targetId: "stray" };
      if (method === "Page.navigate") return handlers.onNavigate?.(params) ?? {};
      return {};
    },
  } as unknown as CdpSocket;
  return { cdp, calls };
}

test("a cross-origin download does not navigate when the tab's browser context is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-transfer-refuse-"));
  const { cdp, calls } = fakeCdp({
    onEvaluate: (expression) => {
      if (expression.includes("await fetch")) return { exceptionDetails: { text: "Failed to fetch" } };
      if (expression.includes("return {")) return { result: { value: { href: "http://files.example/statement.pdf", opened: "" } } };
      return { result: { value: undefined } };
    },
    targetInfo: () => ({}),
  });
  try {
    const outcome = await downloadByClick(cdp, "tab", path.join(root, "statement.pdf"), async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    assert.equal(outcome.result.exitCode, 1);
    assert.match(outcome.result.stderr, /this tab's Chrome profile/);
    assert.equal(calls.some((call) => call.method === "Target.createTarget" || call.method === "Page.navigate"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cross-origin download does not navigate when the new tab is in another browser context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-transfer-mismatch-"));
  const { cdp, calls } = fakeCdp({
    onEvaluate: (expression) => {
      if (expression.includes("await fetch")) return { exceptionDetails: { text: "Failed to fetch" } };
      if (expression.includes("return {")) return { result: { value: { href: "http://files.example/statement.pdf", opened: "" } } };
      return { result: { value: undefined } };
    },
    targetInfo: (targetId) => targetId === "tab" ? { browserContextId: "work" } : { browserContextId: "personal" },
  });
  try {
    const outcome = await downloadByClick(cdp, "tab", path.join(root, "statement.pdf"), async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    assert.equal(outcome.result.exitCode, 1);
    assert.match(outcome.result.stderr, /this tab's Chrome profile/);
    assert.deepEqual(calls.filter((call) => call.method === "Target.createTarget").map((call) => call.params.url), ["about:blank"]);
    assert.equal(calls.some((call) => call.method === "Page.navigate"), false);
    assert.equal(calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "stray"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed background navigation closes the tab and does not save", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-transfer-nav-fail-"));
  const { cdp, calls } = fakeCdp({
    onEvaluate: (expression) => {
      if (expression.includes("await fetch")) return { exceptionDetails: { text: "Failed to fetch" } };
      if (expression.includes("return {")) return { result: { value: { href: "http://files.example/missing.pdf", opened: "" } } };
      return { result: { value: undefined } };
    },
    targetInfo: () => ({ browserContextId: "work" }),
    onNavigate: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
  });
  try {
    const outcome = await downloadByClick(cdp, "tab", path.join(root, "missing.pdf"), async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    assert.equal(outcome.result.exitCode, 1);
    assert.match(outcome.result.stderr, /this tab's Chrome profile/);
    assert.equal(calls.some((call) => call.method === "Page.navigate"), true);
    assert.equal(calls.some((call) => call.method === "Target.closeTarget" && call.params.targetId === "stray"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a download saves the handler's file, captures window.open, and falls back in that tab's browser context", { timeout: scaledMs(180_000) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-transfer-click-"));
  const page = `<!doctype html><title>Statements</title>
<base href="/statements/october/">
<a id=plain href=/october.pdf>October</a>
<a id=based href=/gate>Based</a>
<a id=foreign download>Foreign</a>
<a id=lax>Lax</a>
<a id=hop href=/download>Hop</a>
<a id=report href=/report.html download>Report</a>
<a id=month href=/january.pdf>Month</a>
<a id=popup href=/gate target=_blank>Popup</a>
<a id=cross target=_blank>Cross</a>
<a id=attach target=_blank>Attach</a>
<form id=ask method=get target=_blank action="/statement?month=2026-01">
<input name=month value=2026-10>
<input name=skipped value=2026-01 disabled>
<button type=submit id=ask-submit name=format value=pdf>Save</button>
</form>
<form id=other method=get target=_blank action=/january.pdf>
<input name=month value=2026-10>
<button type=submit id=other-submit formaction="/statement?month=2026-01" name=format value=pdf>Other</button>
</form>
<form id=halt method=get target=_blank action=/october.pdf>
<button type=submit id=halt-submit>Halt</button>
</form>
<script>
month.addEventListener("click", () => { month.href = "/october.pdf"; });
popup.addEventListener("click", (event) => { event.preventDefault(); window.open("/october.pdf"); });
based.addEventListener("click", (event) => { event.preventDefault(); window.open("statement.pdf"); });
halt.addEventListener("submit", (event) => event.preventDefault());
</script>`;
  let laxStatement = "";
  const site = createServer((request, response) => {
    if (request.url === "/download") { response.writeHead(302, { location: laxStatement }); response.end(); return; }
    if (request.url === "/october.pdf") { response.setHeader("content-type", "application/pdf"); response.end(OCTOBER); return; }
    if (request.url === "/january.pdf") { response.setHeader("content-type", "application/pdf"); response.end(JANUARY); return; }
    if (request.url === "/gate") { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Gate</title>"); return; }
    if (request.url === "/report.html") { response.setHeader("content-type", "text/html"); response.end(REPORT); return; }
    if (request.url === "/statement.pdf") { response.setHeader("content-type", "application/pdf"); response.end(JANUARY); return; }
    if (request.url === "/statements/october/statement.pdf") { response.setHeader("content-type", "application/pdf"); response.end(OCTOBER); return; }
    const asked = new URL(request.url ?? "/", "http://127.0.0.1");
    if (asked.pathname === "/statement") {
      const months = asked.searchParams.getAll("month");
      response.setHeader("content-type", "application/pdf");
      response.end(months.length === 1 && months[0] === "2026-10" && asked.searchParams.get("format") === "pdf" && !asked.searchParams.has("skipped") ? OCTOBER : JANUARY);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/files" ? page : "<!doctype html><title>Owner</title>");
  });
  const cross = createServer((request, response) => {
    if (request.url === "/statement.pdf") {
      response.setHeader("content-type", "application/pdf");
      response.end(`who=${request.headers.cookie ?? ""}`);
      return;
    }
    if (request.url === "/statement.bin") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"statement.bin\"" });
      response.end(`attach=${request.headers.cookie ?? ""}\n`);
      return;
    }
    if (request.url === "/foreign.html") {
      const origin = request.headers.origin;
      if (typeof origin === "string") {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-credentials", "true");
      }
      response.setHeader("content-type", "text/html");
      response.end(FOREIGN);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const laxSite = createServer((request, response) => {
    if (request.url === "/statement.pdf" && (request.headers.cookie ?? "").includes("session=lax")) {
      response.setHeader("content-type", "application/pdf");
      response.end(OCTOBER);
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
    }
    response.writeHead(401, { "content-type": "text/html" });
    response.end("<!doctype html><title>Sign in</title>");
  });
  const base = await listen(site);
  const crossBase = await listen(cross);
  const laxListen = await listen(laxSite);
  const laxUrl = `http://localhost:${new URL(laxListen).port}/statement.pdf`;
  laxStatement = laxUrl;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const born: Promise<string | undefined>[] = [];
  const stopBorn = cdp.on("Target.targetCreated", undefined, (params) => {
    const info = params.targetInfo as { targetId?: string; type?: string } | undefined;
    if (!info?.targetId || info.type !== "page") return;
    born.push(cdp.send<{ targetInfo?: { browserContextId?: string } }>("Target.getTargetInfo", { targetId: info.targetId })
      .then((seen) => seen.targetInfo?.browserContextId).catch(() => undefined));
  });
  try {
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetId: owner } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner` });
    while (await evaluate(cdp, owner, "document.readyState") !== "complete") await new Promise((resolve) => setTimeout(resolve, 20));
    await evaluate(cdp, owner, `window.ownerEvents = [];
      document.addEventListener("visibilitychange", () => ownerEvents.push(document.visibilityState));
      addEventListener("blur", () => ownerEvents.push("blur"));`);
    const ownerState = () => evaluate<{ visibility: string; events: string[] }>(cdp, owner, "({ visibility: document.visibilityState, events: window.ownerEvents })");
    assert.equal((await ownerState()).visibility, "visible");

    const { browserContextId: work } = await cdp.send<{ browserContextId: string }>("Target.createBrowserContext");
    const { targetId: workTab } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${base}/files`, background: true, browserContextId: work });
    const { targetId: personalTab } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${base}/files`, background: true });
    const workContext = (await cdp.send<{ targetInfo: { browserContextId?: string } }>("Target.getTargetInfo", { targetId: workTab })).targetInfo.browserContextId;
    const personalContext = (await cdp.send<{ targetInfo: { browserContextId?: string } }>("Target.getTargetInfo", { targetId: personalTab })).targetInfo.browserContextId;
    assert.equal(workContext, work);
    assert.ok(personalContext && personalContext !== work, "the default context is a different browser context");
    for (const tab of [workTab, personalTab]) {
      while (await evaluate(cdp, tab, "document.readyState") !== "complete") await new Promise((resolve) => setTimeout(resolve, 20));
      await evaluate(cdp, tab, `document.querySelector("#cross").href = ${JSON.stringify(`${crossBase}/statement.pdf`)};
        document.querySelector("#attach").href = ${JSON.stringify(`${crossBase}/statement.bin`)};
        document.querySelector("#foreign").href = ${JSON.stringify(`${crossBase}/foreign.html`)};
        document.querySelector("#lax").href = ${JSON.stringify(laxUrl)};`);
    }
    const setCookie = async (targetId: string, value: string) => {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      try {
        await cdp.send("Network.setCookie", { name: "who", value, url: `${crossBase}/`, path: "/" }, sessionId);
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
    };
    await setCookie(workTab, "work");
    await setCookie(personalTab, "personal");
    const { sessionId: laxSession } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: workTab, flatten: true });
    try {
      await cdp.send("Network.setCookie", { name: "session", value: "lax", url: `http://localhost:${new URL(laxListen).port}/`, path: "/", sameSite: "Lax" }, laxSession);
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId: laxSession }).catch(() => undefined);
    }

    const click = (targetId: string, selector: string) => async () => {
      await evaluate(cdp, targetId, `document.querySelector(${JSON.stringify(selector)}).click()`);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const save = async (targetId: string, selector: string, name: string) => {
      const before = born.length;
      await evaluate(cdp, targetId, "window.__nativeOpen = window.open");
      const outcome = await downloadByClick(cdp, targetId, path.join(root, name), click(targetId, selector));
      assert.equal(outcome.result.exitCode, 0, outcome.result.stderr);
      assert.equal(await evaluate(cdp, targetId, "window.open === window.__nativeOpen"), true, "the page's window.open is restored");
      const contexts = (await Promise.all(born.slice(before))).filter((id): id is string => typeof id === "string");
      return { text: await readFile(path.join(root, name), "utf8"), outcome, contexts };
    };

    const plain = await save(workTab, "#plain", "plain.pdf");
    assert.equal(plain.text, OCTOBER);
    assert.match(plain.outcome.result.stdout, /did not open a tab/);
    assert.deepEqual(plain.contexts, [], "a plain link download opens no tab");

    const report = await save(workTab, "#report", "report.html");
    assert.equal(report.text, REPORT);
    assert.doesNotMatch(report.text, /Statements/);
    assert.match(report.outcome.result.stdout, /did not open a tab/);
    assert.deepEqual(report.contexts, [], "an HTML download attribute opens no tab");

    const foreignBefore = born.length;
    const foreign = await downloadByClick(cdp, workTab, path.join(root, "foreign.html"), click(workTab, "#foreign"));
    assert.equal(foreign.result.exitCode, 1);
    assert.match(foreign.result.stderr, /started no download and showed no PDF/);
    await assert.rejects(readFile(path.join(root, "foreign.html")));
    const foreignContexts = (await Promise.all(born.slice(foreignBefore))).filter((id): id is string => typeof id === "string");
    assert.deepEqual([...new Set(foreignContexts)], [work], "a cross-origin HTML fetch stays in this tab's browser context");

    const month = await save(workTab, "#month", "month.pdf");
    assert.equal(month.text, OCTOBER);
    assert.notEqual(month.text, JANUARY);
    assert.equal(month.outcome.from && "url" in month.outcome.from ? month.outcome.from.url : "", `${base}/october.pdf`);
    assert.deepEqual(month.contexts, [], "a handler that picks another month opens no tab");

    const popup = await save(workTab, "#popup", "popup.pdf");
    assert.equal(popup.text, OCTOBER);
    assert.doesNotMatch(popup.text, /Gate/);
    assert.equal(popup.outcome.from && "url" in popup.outcome.from ? popup.outcome.from.url : "", `${base}/october.pdf`);
    assert.deepEqual(popup.contexts, [], "a handler that calls window.open opens no tab");
    assert.equal(await evaluate(cdp, workTab, "location.pathname"), "/files", "the handler popup does not navigate the agent's tab");

    const based = await save(workTab, "#based", "based.pdf");
    assert.equal(based.text, OCTOBER);
    assert.notEqual(based.text, JANUARY);
    assert.equal(based.outcome.from && "url" in based.outcome.from ? based.outcome.from.url : "", `${base}/statements/october/statement.pdf`);
    assert.deepEqual(based.contexts, [], "a base-relative window.open opens no tab");

    const workFile = await save(workTab, "#cross", "work.pdf");
    assert.match(workFile.outcome.result.stdout, /background tab/);
    assert.match(workFile.text, /who=work/);
    assert.doesNotMatch(workFile.text, /personal/);
    assert.deepEqual([...new Set(workFile.contexts)], [work], "the fallback tab stays in the agent tab's browser context");

    const personalFile = await save(personalTab, "#cross", "personal.pdf");
    assert.match(personalFile.text, /who=personal/);
    assert.doesNotMatch(personalFile.text, /who=work/);
    assert.deepEqual([...new Set(personalFile.contexts)], [personalContext], "a default-context fallback does not use the other context");

    const asked = await save(workTab, "#ask-submit", "asked.pdf");
    assert.equal(asked.text, OCTOBER);
    assert.notEqual(asked.text, JANUARY);
    assert.equal(asked.outcome.from && "url" in asked.outcome.from ? asked.outcome.from.url : "", `${base}/statement?month=2026-10&format=pdf`);
    assert.deepEqual(asked.contexts, [], "a GET form download opens no tab");

    const other = await save(workTab, "#other-submit", "other.pdf");
    assert.equal(other.text, OCTOBER);
    assert.notEqual(other.text, JANUARY);
    assert.equal(other.outcome.from && "url" in other.outcome.from ? other.outcome.from.url : "", `${base}/statement?month=2026-10&format=pdf`);
    assert.deepEqual(other.contexts, [], "a formaction download opens no tab");

    const haltedBefore = born.length;
    const halted = await downloadByClick(cdp, workTab, path.join(root, "halted.pdf"), click(workTab, "#halt-submit"));
    assert.equal(halted.result.exitCode, 1);
    assert.match(halted.result.stderr, /started no download/);
    assert.equal(await evaluate(cdp, workTab, "location.pathname"), "/files", "a canceled form is not fetched");
    const haltedContexts = (await Promise.all(born.slice(haltedBefore))).filter((id): id is string => typeof id === "string");
    assert.deepEqual(haltedContexts, [], "a canceled form opens no tab");

    const attached = await save(workTab, "#attach", "attach.bin");
    assert.match(attached.text, /attach=who=work/);
    assert.doesNotMatch(attached.text, /personal/);
    assert.match(attached.outcome.result.stdout, /background tab/);
    assert.deepEqual([...new Set(attached.contexts)], [work], "an attachment download stays in the agent tab's browser context");

    const laxFile = await save(workTab, "#lax", "lax.pdf");
    assert.equal(laxFile.text, OCTOBER);
    assert.doesNotMatch(laxFile.text, /Sign in/);
    assert.match(laxFile.outcome.result.stdout, /background tab/);
    assert.deepEqual([...new Set(laxFile.contexts)], [work], "a Lax-cookie statement stays in the agent tab's browser context");

    const hopped = await save(workTab, "#hop", "hop.pdf");
    assert.equal(hopped.text, OCTOBER);
    assert.doesNotMatch(hopped.text, /Sign in/);
    assert.match(hopped.outcome.result.stdout, /background tab/);
    assert.deepEqual([...new Set(hopped.contexts)], [work], "a redirected Lax-cookie statement stays in the agent tab's browser context");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "none of these downloads switch the owner's tab");
  } finally {
    stopBorn();
    cdp.close();
    await chrome.close();
    site.close();
    cross.close();
    laxSite.close();
    await rm(root, { recursive: true, force: true });
  }
});
