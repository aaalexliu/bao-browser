import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../../src/eval/mcp-client";
import { pageApi } from "../../src/eval/page";
import { STRIPPED_SECRET } from "../../src/v1/saved-secrets";

const fields = [
  { id: "native", type: "password", autocomplete: "off", value: "native-private", secret: true },
  { id: "current", type: "text", autocomplete: "current-password", value: "current-private", secret: true },
  { id: "otp", type: "text", autocomplete: "one-time-code", value: "otp-private", secret: true },
  { id: "card", type: "text", autocomplete: "cc-name", value: "card-private", secret: true },
  { id: "agent", type: "text", autocomplete: "current-password", value: "mcp", secret: true },
  { id: "vendor", type: "text", autocomplete: "current-password", value: "bao", secret: true },
  { id: "adapter", type: "text", autocomplete: "current-password", value: "stdio", secret: true },
  { id: "ordinary", type: "text", autocomplete: "name", value: "Grace Hopper", secret: false },
];
const html = `<!doctype html>${fields.map((field) => `<input id="${field.id}" type="${field.type}" autocomplete="${field.autocomplete}">`).join("")}`;

test("eval page identities retain native type and autocomplete on each lookup", { timeout: 30_000 }, async () => {
  const { testChromium: chromium } = await import("../../src/test-browser.js");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    for (const field of fields) {
      await page.locator(`#${field.id}`).focus();
      const box = await page.locator(`#${field.id}`).boundingBox();
      assert.ok(box);
      for (const request of [
        { op: "id" as const, id: field.id },
        { op: "active" as const },
        { op: "at" as const, x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ]) {
        const hit = await page.evaluate(pageApi, request) as { identity: { id: string; inputType: string; autocomplete: string } };
        assert.equal(hit.identity.id, field.id);
        assert.equal(hit.identity.inputType, field.type);
        assert.equal(hit.identity.autocomplete, field.autocomplete);
      }
    }
  } finally {
    await browser.close();
  }
});

test("eval MCP saves structural secrets without changing tool replies or dispatched values", { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-saved-secrets-eval-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dispatched: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { dispatched.push(body); res.end("ok"); });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`${html}<script>document.addEventListener('input', e => fetch('/value', {method:'POST', body:e.target.value}))</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const { testChromium: chromium } = await import("../../src/test-browser.js");
  const env: NodeJS.ProcessEnv = { ...process.env, BAO_TEST_BROWSER: chromium.executablePath(), HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_MCP_LIVE: "1", BAO_HEADED: "0", BAO_FIXTURE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"]) delete env[key];
  const client = McpClient.start(env);
  t.after(() => client.close());
  const tools = await client.handshake().catch((err) => { throw new Error(`${err.message}\n${client.stderr.join("")}`); });
  assert.ok(tools.includes("type"));
  for (const field of fields) {
    assert.deepEqual(await client.call("click", { ref: field.id }), { text: "OK", isError: false, tools: undefined });
    assert.deepEqual(await client.call("type", { text: field.value }), { text: field.type === "password" ? "STOP login" : "OK", isError: false, tools: undefined });
  }
  assert.deepEqual(dispatched, fields.filter((field) => field.type !== "password").map((field) => field.value));
  const bytes = readFileSync(path.join(home, "trail.jsonl"), "utf8");
  assert.equal(bytes.includes("current-private"), false, "saved trail must not contain the dispatched password value");
  const events = bytes.trim().split("\n").map((line) => JSON.parse(line));
  const typed = events.filter((event) => event.op === "type");
  assert.equal(typed.length, fields.length);
  for (const [index, field] of fields.entries()) {
    const event = typed[index];
    assert.deepEqual(event.source, { agent: "mcp", vendor: "bao", adapter: "stdio" });
    assert.equal(event.identity.id, field.id);
    assert.equal(event.identity.inputType, field.type);
    assert.equal(event.identity.autocomplete, field.autocomplete);
    assert.equal(event.value, field.type === "password" ? undefined : field.secret ? STRIPPED_SECRET : field.value);
    if (field.type !== "password") assert.equal(event.args.text, field.secret ? STRIPPED_SECRET : field.value);
  }
});
