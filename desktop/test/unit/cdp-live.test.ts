import assert from "node:assert/strict";
import test from "node:test";
import { workflowDriver } from "../../src/extension/protocol";
import { migrate, validateWorkflow } from "../../src/v1/schema";
import { navigationAllowed, openerAllowed } from "../../src/cdp-live/allowlist";
import {
  checkboxReach,
  dialogFromNodes,
  mayClickAllow,
  summarizeAx,
  type AxLike,
} from "../../src/cdp-live/consent";
import { assertActivePortFile, parseDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { CDP_LIVE_SERVER_REFUSAL, refusesOwnedBrowser } from "../../src/cdp-live/launch-guard";
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

test("the browser handshake has no Origin header", () => {
  const raw = handshakeRequest("/devtools/browser/example", "127.0.0.1:9222", "abc");
  assert.equal(/\r\nOrigin:/i.test(raw), false);
  assert.match(raw, /^GET \/devtools\/browser\/example HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n/);
  assert.equal(scrubCdp("no /devtools/browser/abc-def"), "no /devtools/browser/<id>");
});

test("DevToolsActivePort is the only file the endpoint reader accepts", () => {
  assert.throws(() => assertActivePortFile("/tmp/Preferences"), /DevToolsActivePort/);
  const parsed = parseDevToolsActivePort("9222\n/devtools/browser/00000000-0000-4000-8000-000000000000\n");
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
