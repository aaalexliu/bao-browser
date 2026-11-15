import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { downloadByClick, uploadThroughChooser } from "../../src/engines/agent-browser-transfer";
import { HANDED_BACK } from "../../../shared/takeover-overlay";

function fakeCdp(): { cdp: CdpSocket; methods: string[]; expressions: string[] } {
  const methods: string[] = [];
  const expressions: string[] = [];
  const cdp = {
    send: async (method: string, params?: { expression?: string }) => {
      methods.push(method);
      if (params?.expression) expressions.push(params.expression);
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "Runtime.evaluate") return { result: { value: undefined } };
      return {};
    },
    on: () => () => undefined,
  };
  return { cdp: cdp as unknown as CdpSocket, methods, expressions };
}

const skipped = { stdout: `${HANDED_BACK}\n`, stderr: "", exitCode: 0 };

function livePage(): { cdp: CdpSocket; window: { open: (...args: unknown[]) => unknown }; realOpen: (...args: unknown[]) => unknown; listeners: Map<string, Set<(event: unknown) => void>>; opens: number } {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let opens = 0;
  const realOpen = () => { opens += 1; return null; };
  const window = {
    open: realOpen as (...args: unknown[]) => unknown,
    addEventListener(type: string, fn: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set<(event: unknown) => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  const document = { querySelector: () => null, baseURI: "https://shop.example/" };
  const context = vm.createContext({ window, document, URL });
  const cdp = {
    send: async (method: string, params?: { expression?: string }) => {
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab", type: "page", url: "https://shop.example/" }] };
      if (method === "Target.getTargetInfo") return { targetInfo: {} };
      if (method === "Runtime.evaluate" && params?.expression) return { result: { value: vm.runInContext(params.expression, context) as unknown } };
      return {};
    },
    on: () => () => undefined,
  };
  return { cdp: cdp as unknown as CdpSocket, window, realOpen, listeners, get opens() { return opens; } };
}

test("a skipped upload click does not set files on the chooser", async () => {
  const { cdp, methods } = fakeCdp();
  const result = await uploadThroughChooser(cdp, "tab", ["/tmp/a.txt"], async () => skipped);
  assert.equal(result, skipped);
  assert.equal(methods.includes("DOM.setFileInputFiles"), false);
  assert.equal(methods.includes("Page.setInterceptFileChooserDialog"), true);
});

test("a skipped, failed, or thrown download click restores navigation and claims no file", async () => {
  const page = livePage();
  const skippedDownload = await downloadByClick(page.cdp, "tab", "/tmp/a.txt", async () => skipped);
  assert.equal(skippedDownload.result, skipped);
  assert.equal(skippedDownload.from, undefined);
  assert.equal(page.window.open, page.realOpen);
  assert.equal(page.listeners.get("click")?.size ?? 0, 0);
  assert.equal(page.listeners.get("submit")?.size ?? 0, 0);
  page.window.open("https://shop.example/next");
  assert.equal(page.opens, 1);

  const failed = livePage();
  const failedDownload = await downloadByClick(failed.cdp, "tab", "/tmp/a.txt", async () => ({ stdout: "", stderr: "no\n", exitCode: 1 }));
  assert.equal(failedDownload.result.exitCode, 1);
  assert.equal(failedDownload.from, undefined);
  assert.equal(failed.window.open, failed.realOpen);
  assert.equal(failed.listeners.get("click")?.size ?? 0, 0);

  const thrown = livePage();
  await assert.rejects(() => downloadByClick(thrown.cdp, "tab", "/tmp/a.txt", async () => { throw new Error("click failed"); }));
  assert.equal(thrown.window.open, thrown.realOpen);
  assert.equal(thrown.listeners.get("click")?.size ?? 0, 0);
  assert.equal(thrown.listeners.get("submit")?.size ?? 0, 0);
});
