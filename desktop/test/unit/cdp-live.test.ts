import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowDriver } from "../../src/extension/protocol";
import { migrate, validateWorkflow } from "../../src/v1/schema";
import { INSTACART_HOSTS, navigationAllowed, navigationRefusal, openerAllowed } from "../../src/cdp-live/allowlist";
import { addLabelOk, addProductName, cartControlLabel, cartCountFromLabel, cartLabelOk, cartRestored, classifyDialog, clickForbidden, readInstacart, removeLabelOk, searchLabelOk, stapleNameOk } from "../../src/cdp-live/instacart";
import { PIERCE_QUERY, TRUST_CLEANUP, attachLivePage, attachLiveTarget, openLiveWindow, redactOverlay } from "../../src/cdp-live/driver";
import {
  attachPathMatches,
  lockIsStale as attachLockIsStale,
  parseLockText,
  pickExistingPage,
  redactForShot,
  workflowFromAudit,
} from "../../src/cdp-live/attach";
import { liveShotUrl, redactLabel, shotNameOk } from "../../src/cdp-live/audit";
import { acquireCdpLock, lockIsStale, lockText, parseLock, releaseCdpLock } from "../../src/cdp-live/lock";
import { loginDiffConclusion } from "../../src/cdp-live/login-diff";
import { liveSessionView, screenFromQuery } from "../../src/app/live-view";
import {
  clickAllowed,
  dashboardNavigation,
  defaultContextJoinId,
  isolatedFromDashboard,
  pathIsLogin,
  pickDashboardPage,
  publicPath,
  readSurface,
  redactText,
  sameContext,
  signedOutSurface,
} from "../../src/cdp-live/session";
import {
  checkboxReach,
  dialogFromNodes,
  mayClickAllow,
  summarizeAx,
  type AxLike,
} from "../../src/cdp-live/consent";
import { assertActivePortFile, parseDevToolsActivePort, parseListenPid } from "../../src/cdp-live/endpoint";
import { CDP_LIVE_SERVER_REFUSAL, refusesOwnedBrowser } from "../../src/cdp-live/launch-guard";
import { TRUST_SOURCE } from "../../src/cdp-live/driver";
import { ServerFrameDecoder, handshakeRequest, scrubCdp } from "../../src/cdp-live/socket";

const ready = {
  openedByBao: true,
  connectionStartedAt: 1_000,
  now: 2_000,
  dialogPresentBeforeConnect: false,
  dialog: { present: true, buttonCount: 1 },
};

test("navigation allowlist is books.toscrape.com over http and https", () => {
  assert.equal(navigationAllowed("https://books.toscrape.com/"), true);
  assert.equal(navigationAllowed("http://books.toscrape.com/catalogue/category/books/mystery_3/index.html"), true);
  assert.equal(navigationAllowed("https://books.toscrape.com:443/"), true);
  assert.equal(navigationAllowed("https://BOOKS.toscrape.com/"), true);
  assert.equal(navigationAllowed("https://www.books.toscrape.com/"), false);
  assert.equal(navigationAllowed("https://books.toscrape.com.evil.com/"), false);
  assert.equal(navigationAllowed("https://evil.com/?next=https://books.toscrape.com"), false);
  assert.equal(navigationAllowed("https://notbooks.toscrape.com/"), false);
  assert.equal(navigationAllowed("https://user:pass@books.toscrape.com/"), false);
  assert.equal(navigationAllowed("javascript:alert(1)"), false);
  assert.equal(navigationAllowed("data:text/html,hi"), false);
  assert.equal(navigationAllowed("file:///tmp/x"), false);
  assert.equal(navigationAllowed("chrome://inspect/"), false);
  assert.equal(navigationAllowed("chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/allow.html"), false);
  assert.equal(navigationAllowed("about:blank"), false);
  assert.equal(navigationAllowed(""), false);
  assert.equal(openerAllowed("about:blank"), true);
  assert.equal(openerAllowed("about:blank#x"), false);
  assert.equal(openerAllowed("https://books.toscrape.com/"), true);
});

test("instacart navigation stays on the site and off checkout", () => {
  assert.equal(navigationAllowed("https://www.instacart.com/"), false);
  assert.equal(navigationAllowed("https://www.instacart.com/store/s?k=bananas", INSTACART_HOSTS), true);
  assert.equal(navigationAllowed("https://instacart.com/", INSTACART_HOSTS), true);
  assert.equal(navigationAllowed("https://www.instacart.com/store/checkout", INSTACART_HOSTS), false);
  assert.equal(navigationRefusal("https://www.instacart.com/login", INSTACART_HOSTS), "blocked-path");
  assert.equal(navigationRefusal("https://www.instacart.com/account/settings", INSTACART_HOSTS), "blocked-path");
  assert.equal(navigationAllowed("https://example.com/", INSTACART_HOSTS), false);
  assert.equal(navigationAllowed("https://cdn.example.com/banana.jpg", INSTACART_HOSTS), false);
  assert.equal(clickForbidden("Go to checkout"), true);
  assert.equal(clickForbidden("Place order"), true);
  assert.equal(clickForbidden("Start free trial"), true);
  assert.equal(clickForbidden("Add"), false);
  assert.equal(addLabelOk("Add"), true);
  assert.equal(addLabelOk("Add to cart"), true);
  assert.equal(addLabelOk("Checkout"), false);
  assert.equal(searchLabelOk("Search products and stores"), true);
  assert.equal(searchLabelOk("Enter your address"), false);
  assert.equal(cartLabelOk("Cart, 2 items"), true);
  assert.equal(cartLabelOk("View Cart. Items in cart: 0"), true);
  assert.equal(cartLabelOk("Add $3.99 to get $0 delivery fee 1"), true);
  assert.equal(cartLabelOk("Add $3.99 to get $0 delivery fee"), false);
  assert.equal(cartLabelOk("Add to cart"), false);
  assert.equal(cartLabelOk("Go to checkout"), false);
  assert.equal(cartLabelOk("Distinct items in cart: 2"), false);
  assert.equal(cartCountFromLabel("View Cart. Items in cart: 0", null), 0);
  assert.equal(cartCountFromLabel("Cart, 2 items", null), 2);
  assert.equal(cartCountFromLabel("Add $3.99 to get $0 delivery fee 2", null), 2);
  assert.equal(cartCountFromLabel("View Cart", "4"), 4);
  assert.equal(cartLabelOk("Open cart"), true);
  assert.equal(cartLabelOk("View 2 items in your cart"), true);
  assert.equal(cartCountFromLabel("View 2 items in your cart", null), 2);
  assert.equal(cartLabelOk("See the 2 fresh items in your bag"), true);
  assert.equal(cartCountFromLabel("See the 2 fresh items in your bag", null), 2);
  assert.equal(cartLabelOk("See the 2 fresh items in your tote"), true);
  assert.equal(cartCountFromLabel("See the 2 fresh items in your tote", null), 2);
  assert.equal(cartLabelOk("3 distinct items in cart"), false);
  assert.equal(cartControlLabel("View cart", "View 2 items in your cart"), "View 2 items in your cart");
  assert.equal(cartControlLabel("View 2 items in your cart", "2"), "View 2 items in your cart");
  assert.equal(cartCountFromLabel("View cart Items in cart: 21 Add $3.99 to get $0 delivery fee 21", null), 21);
  assert.equal(cartCountFromLabel("View cart Items in cart 4 Add $3.99 to get $0 delivery fee 4", null), 4);
  assert.equal(cartCountFromLabel("Cart 0", null), 0);
  assert.equal(cartCountFromLabel("Open cart 3", null), 3);
  assert.equal(addLabelOk("Add"), true);
  assert.equal(addLabelOk("Add 1 ct Organic Bananas"), true);
  assert.equal(addLabelOk("Add 1 ct Banana bread"), false);
  assert.equal(addLabelOk("Add 2 ct Organic Bananas"), false);
  assert.equal(addLabelOk("Add $3.99 to get $0 delivery fee 1"), false);
  assert.equal(addProductName("Add 1 ct Organic Bananas"), "Organic Bananas");
  assert.equal(stapleNameOk("Organic Bananas"), true);
  assert.equal(stapleNameOk("Banana bread"), false);
  assert.equal(removeLabelOk("Decrease quantity", "decrease", 2), true);
  assert.equal(removeLabelOk("Decrement quantity of Organic Bananas", "decrease", 1), true);
  assert.equal(removeLabelOk("Remove", "remove", 1), true);
  assert.equal(removeLabelOk("Remove Organic Bananas", "remove", 1), true);
  assert.equal(removeLabelOk("Remove", "remove", 2), false);
  assert.equal(removeLabelOk("Remove all", "remove", 1), false);
  assert.equal(classifyDialog(""), "");
  assert.equal(classifyDialog("Your cart is empty"), "cart");
  assert.equal(classifyDialog("Start your free trial"), "trial");
  assert.equal(classifyDialog("Enter your address"), "address");
  assert.equal(classifyDialog("A note about pickup hours"), "other");
  assert.equal(cartRestored(2, 3, 2), true);
  assert.equal(cartRestored(2, 4, 2), false);
  const page = readInstacart.toString();
  assert.match(page, /cartLabelOk\(/);
  assert.match(page, /shadowRoot/);
  assert.match(page, /classifyDialog\(/);
  assert.match(page, /dialogClass === "other"/);
  assert.match(page, /openSearch/);
  assert.doesNotMatch(page, /require\(/);
  assert.doesNotMatch(page, /document\.cookie/);
  assert.doesNotMatch(page, /\.click\s*\(/);
  assert.match(PIERCE_QUERY, /shadowRoot/);
  assert.doesNotMatch(PIERCE_QUERY, /cookie/);
});

test("Allow is clicked only for the dialog bao just opened", () => {
  assert.equal(mayClickAllow(ready), true);
  assert.equal(mayClickAllow({ ...ready, openedByBao: false }), false);
  assert.equal(mayClickAllow({ ...ready, connectionStartedAt: null }), false);
  assert.equal(mayClickAllow({ ...ready, dialogPresentBeforeConnect: true }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: false, buttonCount: 1 } }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: true, buttonCount: 0 } }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: true, buttonCount: 2 } }), false);
  assert.equal(mayClickAllow({ ...ready, now: ready.connectionStartedAt + 180_001 }), false);
  assert.equal(mayClickAllow({ ...ready, now: ready.connectionStartedAt - 1 }), false);
});

test("a Chrome tree with no window is not typed into", () => {
  assert.equal(checkboxReach({ checkbox: { found: false }, roles: { AXApplication: 1, AXMenuBar: 1 } }), "stop");
  assert.equal(checkboxReach({ checkbox: { found: false }, roles: { AXWindow: 2 } }), "open-inspect");
  assert.equal(checkboxReach({ checkbox: { found: true }, roles: {} }), "ready");
});

test("Allow sites is not the remote-debugging Allow button", () => {
  const nodes: AxLike[] = [
    { role: "AXButton", name: "Allow sites", title: "Allow sites" },
    { role: "AXCheckBox", name: "Allow remote debugging for this browser instance", value: "1" },
    { role: "AXWindow", name: "Inbox - Google Chrome", title: "Inbox - Google Chrome" },
  ];
  const dialog = dialogFromNodes(nodes);
  assert.equal(dialog.present, false);
  assert.equal(dialog.buttonCount, 0);
  assert.equal(mayClickAllow({ ...ready, dialog }), false);

  const shown: AxLike[] = [
    { role: "AXStaticText", name: "Allow remote debugging?", title: "" },
    { role: "AXButton", name: "Allow", title: "Allow" },
    { role: "AXButton", name: "Cancel", title: "Cancel" },
    { role: "AXButton", name: "Allow sites", title: "Allow sites" },
  ];
  const live = dialogFromNodes(shown);
  assert.equal(live.present, true);
  assert.equal(live.buttonCount, 1);
  assert.equal(mayClickAllow({ ...ready, dialog: live }), true);
});

test("AX summary drops other window titles", () => {
  const summary = summarizeAx([
    { role: "AXWindow", name: "Bank - Google Chrome", title: "Bank - Google Chrome" },
    { role: "AXStaticText", name: "Allow remote debugging?" },
    { role: "AXButton", name: "Allow", title: "Allow" },
    { role: "AXButton", name: "Allow sites" },
    { role: "AXCheckBox", name: "Allow remote debugging for this browser instance", value: "0" },
    { role: "AXLink", name: "https://secret.example/account" },
  ]);
  const blob = JSON.stringify(summary);
  assert.equal(blob.includes("secret.example"), false);
  assert.equal(blob.includes("Bank"), false);
  assert.equal(blob.includes("Allow remote debugging?"), true);
  assert.equal(summary.dialog.buttonCount, 1);
  assert.equal(summary.checkbox.value, "0");
});

test("cdp-live is accepted and does not select Playwright's launcher or the extension", () => {
  const doc = migrate({
    id: "wf-cdp-live",
    name: "Live",
    version: 2,
    schema: "bao.workflow/v2",
    startUrl: "https://books.toscrape.com/",
    createdAt: 1,
    inputs: [],
    steps: [],
  });
  assert.deepEqual(validateWorkflow({ ...doc, driver: "cdp-live" }), []);
  assert.ok(validateWorkflow({ ...doc, driver: "cdp" as "cdp-live" }).includes("driver"));
  assert.equal(workflowDriver({ driver: "cdp-live" }), "playwright");
  assert.equal(workflowDriver({ driver: "cdp" }), "playwright");
  assert.equal(refusesOwnedBrowser("cdp-live"), true);
  assert.equal(refusesOwnedBrowser("playwright"), false);
  assert.equal(refusesOwnedBrowser("extension"), false);
  assert.equal(refusesOwnedBrowser("cdp"), false);
  assert.match(CDP_LIVE_SERVER_REFUSAL, /live attach/);
});

test("click trust is recorded from the event and kept across navigations", () => {
  assert.match(TRUST_SOURCE, /event\.isTrusted === true/);
  assert.match(TRUST_SOURCE, /sessionStorage\.setItem\("__baoTrustLog"/);
  assert.equal(TRUST_SOURCE.includes("isTrusted = true"), false);
  assert.equal(TRUST_SOURCE.includes("navigator"), false);
});

test("the browser handshake has no Origin header", () => {
  const raw = handshakeRequest("/devtools/browser/example", "127.0.0.1:9222", "abc");
  assert.equal(/\r\nOrigin:/i.test(raw), false);
  assert.match(raw, /^GET \/devtools\/browser\/example HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n/);
  assert.equal(scrubCdp("no /devtools/browser/abc-def"), "no /devtools/browser/<id>");
});

test("a new live window does not create a browser context", () => {
  const source = openLiveWindow.toString();
  assert.equal(source.includes("createBrowserContext"), false);
  assert.match(source, /Target\.createTarget/);
  assert.match(source, /newWindow: options\.newWindow !== false/);
  assert.match(source, /createParams\.browserContextId = options\.browserContextId/);
});

test("sign-in pages stay in the default context or move to a new tab", () => {
  assert.equal(pathIsLogin("/login/index"), true);
  assert.equal(pathIsLogin("/member/overview"), false);
  assert.equal(pathIsLogin("/freeze/confirm"), false);
  assert.equal(signedOutSurface({ blocked: "stop-path", path: "/login/index", title: "Sign in" }), true);
  assert.equal(signedOutSurface({ blocked: "", path: "/member", title: "Sign in to your account" }), true);
  assert.equal(signedOutSurface({ blocked: "captcha", path: "/login/index", title: "Sign in" }), false);
  assert.equal(signedOutSurface({ blocked: "", path: "/member/freeze", title: "Credit freeze", headings: ["Unfreeze your credit"] }), false);
  const pages = [
    { id: "login", login: true, path: "/login/index" },
    { id: "root", login: false, path: "/" },
    { id: "dash", login: false, path: "/member/overview" },
  ];
  assert.equal(pickDashboardPage(pages)?.id, "dash");
  assert.equal(pickDashboardPage([{ id: "root", login: false, path: "/" }])?.id, "root");
  assert.equal(sameContext("default", "default"), true);
  assert.equal(sameContext("other", "default"), false);
  assert.equal(sameContext("other", null), null);
  assert.equal(isolatedFromDashboard("default", "default", ["default"]), false);
  assert.equal(isolatedFromDashboard("other", "default", []), true);
  assert.equal(isolatedFromDashboard("created", null, ["created"]), true);
  assert.equal(defaultContextJoinId("default", []), "default");
  assert.equal(defaultContextJoinId("created", ["created"]), "");
  assert.equal(defaultContextJoinId("", []), "");
  assert.equal(dashboardNavigation({ host: "usa.experian.com", path: "/member/overview" }, ["usa.experian.com"]), "https://usa.experian.com/member/overview");
  assert.equal(dashboardNavigation({ host: "evil.test", path: "/member" }, ["usa.experian.com"]), "");
  assert.equal(dashboardNavigation({ host: "usa.experian.com", path: "/member?token=1" }, ["usa.experian.com"]), "");
});

test("an intent session publishes a path and will not click a commit control", () => {
  assert.equal(publicPath("https://example.com/member/security-freeze?token=1#x"), "/member/security-freeze");
  assert.equal(publicPath("https://example.com/member/123456/item"), "/member/:id/item");
  assert.equal(publicPath("https://example.com/a/00000000-0000-4000-8000-000000000000/b"), "/a/:id/b");
  assert.equal(redactText("Welcome back, Alex"), "[greeting]");
  assert.equal(redactText("user@example.com"), "");
  assert.equal(clickAllowed("Manage freeze", "link", "free trial|purchase", "^(confirm|submit|unfreeze)\\b"), true);
  assert.equal(clickAllowed("Unfreeze", "button", "free trial|purchase", "^(confirm|submit|unfreeze)\\b"), false);
  assert.equal(clickAllowed("Confirm", "button", "free trial|purchase", "^(confirm|submit|unfreeze)\\b"), false);
  assert.equal(clickAllowed("Confirm", "submit", "free trial|purchase", "^(confirm|submit|unfreeze)\\b"), false);
  assert.equal(clickAllowed("Start free trial", "link", "free trial|purchase", "^(confirm|submit)\\b"), false);
  assert.equal(clickAllowed("1 day", "radio", "", ""), false);
  const page = readSurface.toString();
  assert.match(page, /shadowRoot/);
  assert.doesNotMatch(page, /document\.cookie/);
  assert.doesNotMatch(page, /\.click\s*\(/);
});

test("an attach run picks one open page and does not create or close a target", () => {
  const pages = [
    { targetId: "other", host: "usa.experian.com", path: "/login/index" },
    { targetId: "dash", host: "usa.experian.com", path: "/mfe/dashboard" },
    { targetId: "books", host: "books.toscrape.com", path: "/mfe/dashboard" },
  ];
  const choice = pickExistingPage(pages, ["usa.experian.com"], "/mfe/dashboard/");
  assert.equal(choice.matches, 1);
  assert.equal(choice.page?.targetId, "dash");
  const ambiguous = pickExistingPage([
    { targetId: "a", host: "usa.experian.com", path: "/mfe/dashboard" },
    { targetId: "b", host: "usa.experian.com", path: "/mfe/dashboard" },
  ], ["usa.experian.com"], "/mfe/dashboard");
  assert.equal(ambiguous.page, null);
  assert.equal(ambiguous.matches, 2);
  assert.equal(pickExistingPage(pages, ["usa.experian.com"], "/missing").matches, 0);
  assert.equal(attachPathMatches("https://usa.experian.com/mfe/dashboard?x=1", "/mfe/dashboard"), true);
  assert.equal(attachPathMatches("https://usa.experian.com/login/index", "/mfe/dashboard"), false);
  const attach = attachLivePage.toString();
  assert.equal(attach.includes("createTarget"), false);
  assert.equal(attach.includes("closeTarget"), false);
  assert.match(attach, /preserveTarget|true/);
  const end = attachLivePage.toString() + "\n" + TRUST_CLEANUP;
  assert.match(end, /sessionStorage\.removeItem\("__baoTrustLog"\)/);
  assert.doesNotMatch(TRUST_CLEANUP, /sessionStorage\.getItem/);
  assert.doesNotMatch(redactForShot.toString(), /document\.cookie|localStorage|sessionStorage|return text/);
  const workflow = workflowFromAudit({
    id: "wf-unfreeze-credit",
    name: "Unfreeze credit",
    intent: "Reach the Unfreeze credit screen and stop before confirming",
    startUrl: "https://usa.experian.com/mfe/dashboard",
    createdAt: 1,
    steps: [{ name: "click", path: "/mfe/credit", label: "Credit freeze", kind: "link" }],
    confirmLabel: "Confirm unfreeze",
  });
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(workflow.driver, "cdp-live");
  assert.equal(workflow.steps.at(-1)?.action, "confirm");
  assert.equal(workflow.steps.at(-1)?.human, true);
  assert.equal(workflow.steps[0]?.action, "click");
  const parsed = parseLockText("agent=bc-test\nstartedAt=1000\n");
  assert.equal(parsed?.agent, "bc-test");
  const lines = parseLockText("bc-other\n1793154442761\n");
  assert.equal(lines?.agent, "bc-other");
  assert.equal(lines?.startedAt, 1793154442761);
  assert.equal(attachLockIsStale(1_000, 1_000 + 20 * 60 * 1000), false);
  assert.equal(attachLockIsStale(1_000, 1_000 + 20 * 60 * 1000 + 1), true);
});

test("a live session view stays on this machine and blurs the page shot", () => {
  assert.equal(screenFromQuery("?screen=live"), "live");
  assert.equal(screenFromQuery("?screen=library"), "");
  assert.equal(shotNameOk("shot-001.png"), true);
  assert.equal(shotNameOk("../session.json"), false);
  assert.equal(liveShotUrl("shot-001.png"), "/api/live-session/shots/shot-001.png");
  assert.equal(liveShotUrl("../x.png"), "");
  assert.equal(redactLabel("bananas $1.29"), "bananas");
  assert.equal(redactLabel("user@example.com"), "");
  const html = liveSessionView({
    id: "live",
    intent: "Add one cheap item, then remove it.",
    status: "passed",
    host: "www.instacart.com",
    updatedAt: 1,
    steps: [{ name: "add", status: "passed", ms: 12 }],
    audit: [{ action: "allow", label: "Allow", path: "", isTrusted: null, ms: 80, at: 1, shot: "", via: "ax" },
      { action: "add", label: "Add", path: "/store/s", isTrusted: true, ms: 40, at: 2, shot: "shot-001.png", via: "cdp" }],
    note: "",
  });
  assert.match(html, /id="live-steps"/);
  assert.match(html, /id="live-audit"/);
  assert.match(html, /AX press/);
  assert.match(html, /\/api\/live-session\/shots\/shot-001\.png/);
  assert.doesNotMatch(html, /https?:/);
  const veil = redactOverlay.toString();
  assert.match(veil, /backdrop-filter:blur\(18px\)/);
  assert.doesNotMatch(veil, /document\.cookie/);
  assert.match(attachLiveTarget.toString(), /attachLivePage/);
  assert.doesNotMatch(attachLiveTarget.toString(), /closeTarget|createTarget/);
});

test("the browser lock is exclusive and a stale lock can be taken", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-lock-"));
  const file = path.join(dir, "lock");
  assert.equal(parseLock(lockText("agent-a", 10))?.agentId, "agent-a");
  assert.equal(lockIsStale(1, 20 * 60 * 1000 + 2), true);
  let now = 1_000;
  let tries = 0;
  await acquireCdpLock("agent-a", { file, now: () => now, timeoutMs: 1_000, sleep: async () => undefined });
  await assert.rejects(acquireCdpLock("agent-b", {
    file,
    now: () => now + tries,
    timeoutMs: 0,
    sleep: async () => { tries += 1; },
  }), /held/);
  releaseCdpLock("agent-b", file);
  assert.equal(parseLock(readFileSync(file, "utf8"))?.agentId, "agent-a");
  now = 1_000 + 20 * 60 * 1000 + 5;
  await acquireCdpLock("agent-b", { file, now: () => now, timeoutMs: 1_000, sleep: async () => undefined });
  releaseCdpLock("agent-b", file);
});

test("login follows more than one open tab only when the measurements say so", () => {
  assert.match(loginDiffConclusion({
    existingLoggedIn: 2,
    duplicateLoggedIn: true,
    duplicateOpened: true,
    cookieNamesMatch: true,
    sessionKeysMatch: false,
    webdriverOnDuplicate: false,
    originalSurvived: true,
  }), /not locked to one tab/);
  assert.match(loginDiffConclusion({
    existingLoggedIn: 1,
    duplicateLoggedIn: false,
    duplicateOpened: true,
    cookieNamesMatch: true,
    sessionKeysMatch: false,
    webdriverOnDuplicate: false,
    originalSurvived: true,
  }), /session storage/);
  assert.equal(loginDiffConclusion({
    existingLoggedIn: 1,
    duplicateLoggedIn: null,
    duplicateOpened: false,
    cookieNamesMatch: null,
    sessionKeysMatch: null,
    webdriverOnDuplicate: null,
    originalSurvived: true,
  }), "unknown");
});

test("DevToolsActivePort is the only file the endpoint reader accepts", () => {
  assert.throws(() => assertActivePortFile("/tmp/Preferences"), /DevToolsActivePort/);
  const parsed = parseDevToolsActivePort("9222\n/devtools/browser/00000000-0000-4000-8000-000000000000\n");
  assert.equal(parseListenPid("Google 92286 alexliu 198u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)\n", 9222), 92286);
  assert.equal(parseListenPid("Google 8920 alexliu 12u IPv4 0x1 0t0 TCP 127.0.0.1:25319 (LISTEN)\n", 9222), null);
  assert.equal(parsed.port, 9222);
  assert.equal(parsed.browserPath, "/devtools/browser/00000000-0000-4000-8000-000000000000");
  assert.throws(() => parseDevToolsActivePort("9222\n/devtools/page/abc\n"), /browser target/);
  const decoder = new ServerFrameDecoder();
  const payload = Buffer.from("{\"id\":1,\"result\":{\"ok\":true}}");
  const header = Buffer.from([0x81, payload.length]);
  assert.equal(decoder.push(header.subarray(0, 1)).length, 0);
  const frames = decoder.push(Buffer.concat([header.subarray(1), payload]));
  assert.equal(frames[0]?.text, payload.toString("utf8"));
});
