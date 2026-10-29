import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCaptureUrl } from "../../src/app/capture-url";
import { fixtureStartValue, productWindowTitle, teachHome } from "../../src/app/views";

test("node discovery and the single-instance lock", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-launch-"));
  const bin = path.join(dir, "bao-launch-test");
  try {
    execFileSync("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      path.join(process.cwd(), "desktop/packaging/macos/bao-launch.c"),
      path.join(process.cwd(), "desktop/packaging/macos/bao-launch-test.c"),
      "-o",
      bin,
    ], { stdio: "inherit", timeout: 60_000 });
    const out = execFileSync(bin, { encoding: "utf8", timeout: 20_000 });
    assert.match(out, /^ok \d+\n$/);
    const count = Number(out.match(/^ok (\d+)/)?.[1]);
    assert.ok(count >= 40, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the product window title is Bao and the capture field hides the listen address", () => {
  assert.equal(productWindowTitle(), "Bao");
  assert.equal(fixtureStartValue(), "/fixture");
  assert.equal(fixtureStartValue().includes("127.0.0.1"), false);
  assert.equal(teachHome([]).includes("127.0.0.1"), false);
  assert.match(teachHome([]), /value="\/fixture"/);
  const client = readFileSync(path.join(process.cwd(), "desktop/src/app/client.ts"), "utf8");
  assert.match(client, /productWindowTitle\(\)/);
  assert.equal(client.includes("location.origin"), false);
  const html = readFileSync(path.join(process.cwd(), "desktop/src/app/public/index.html"), "utf8");
  assert.match(html, /<title>Bao<\/title>/);
});

test("a path capture target stays on this app", () => {
  assert.equal(resolveCaptureUrl("/fixture", 4787), "http://127.0.0.1:4787/fixture");
  assert.equal(resolveCaptureUrl("", 4787), "http://127.0.0.1:4787/fixture");
  assert.equal(resolveCaptureUrl("  /secure", 9), "http://127.0.0.1:9/secure");
  assert.equal(resolveCaptureUrl("https://example.com/in", 4787), "https://example.com/in");
  assert.equal(resolveCaptureUrl("//evil.example/fixture", 4787), "//evil.example/fixture");
});

test("the Mac test card does not send anyone to the listen address", () => {
  const card = readFileSync(path.join(process.cwd(), "docs/mac-test.md"), "utf8");
  const lines = card.split("\n");
  const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  assert.ok(count <= 40, `mac-test.md is ${count} lines`);
  assert.equal(card.includes("127.0.0.1"), false);
  assert.equal(card.includes("4787"), false);
  assert.equal(card.includes("BAO_NODE"), false);
  assert.equal(card.includes("SCContentFilter"), false);
  assert.equal(card.includes("AXSize"), false);
  assert.equal(card.includes("CDP"), false);
  assert.match(card, /mac-build\.md/);
  assert.match(card, /helper ok/);
  const guide = readFileSync(path.join(process.cwd(), "docs/v1.md"), "utf8");
  assert.equal(guide.includes("Open `http://127.0.0.1:4787`"), false);
});
