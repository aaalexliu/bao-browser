import assert from "node:assert/strict";
import test from "node:test";
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

test("a skipped upload click does not set files on the chooser", async () => {
  const { cdp, methods } = fakeCdp();
  const result = await uploadThroughChooser(cdp, "tab", ["/tmp/a.txt"], async () => skipped);
  assert.equal(result, skipped);
  assert.equal(methods.includes("DOM.setFileInputFiles"), false);
  assert.equal(methods.includes("Page.setInterceptFileChooserDialog"), true);
});

test("a skipped download click does not read the page click or claim a file", async () => {
  const { cdp, expressions } = fakeCdp();
  const outcome = await downloadByClick(cdp, "tab", "/tmp/a.txt", async () => skipped);
  assert.equal(outcome.result, skipped);
  assert.equal(expressions.some((expression) => expression.includes("delete window.__baoDownloadHref")), false);
});
