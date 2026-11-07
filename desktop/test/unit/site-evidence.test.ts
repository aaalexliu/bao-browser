import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";

test("site evidence and login details retain personal-looking text within existing limits", { timeout: 60000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-site-evidence-"));
  const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const phrases = ["fixture@example.test", "123-45-6789", "482731"];
  try {
    for (const detail of phrases) {
      const response = await post("/api/prompt", { kind: "login", detail });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).loginWait, { message: "waiting for you to log in", detail });
    }
    assert.equal((await post("/api/prompt", { kind: "login", detail: "x".repeat(121) })).status, 400);
    const html = `<style>p { width: 320px; height: 40px; }</style>${phrases.map((text) => `<p>${text}</p>`).join("")}`;
    assert.equal((await post("/api/site/open", { url: `data:text/html,${encodeURIComponent(html)}` })).status, 200);
    const texts = await post("/api/site/text", { phrases });
    assert.equal(texts.status, 200);
    assert.deepEqual((await texts.json()).texts, phrases);
    for (const [index, phrase] of phrases.entries()) {
      const file = `card-${index}.png`;
      const shot = await post("/api/site/shot", { phrase, file });
      assert.equal(shot.status, 200);
      assert.deepEqual(await shot.json(), { file });
      const png = readFileSync(path.join(home, "shots", file));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 320);
      assert.equal(png.readUInt32BE(20), 40);
    }
    assert.equal((await post("/api/site/shot", { phrase: "" })).status, 400);
    assert.equal((await post("/api/site/shot", { phrase: "x".repeat(81) })).status, 400);
    assert.equal((await post("/api/site/shot", { phrase: phrases[0], file: "invalid name.png" })).status, 400);
    assert.equal((await post("/api/site/shot", { phrase: "missing status" })).status, 404);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
