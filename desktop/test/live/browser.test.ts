// Real Chrome, local fixture page, no model, no vendor network.
// Capture through the recorder, then replay twice with different inputs.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome } from "../../src/launch";

process.env.BAO_DRIVE = "1";

async function post(port: number, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json.error || text}`);
  return json;
}

test("capture login, upload, and drop, then replay with two input sets", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-"));
  const file = path.join(home, "note.txt");
  writeFileSync(file, "hello bao\n");
  const app = await startApp({ home, port: 0 });
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture` });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: "ada" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "SuperSecretPassword!" } });
    await post(app.port, "/api/sessions/drive", { click: "#login-btn" });
    await post(app.port, "/api/sessions/drive", { upload: { selector: "#file", path: file } });
    await post(app.port, "/api/sessions/drive", { drop: { selector: "#drop", name: "note.txt", path: file } });
    const workflow = await post(app.port, "/api/sessions/stop") as { id: string; inputs: { name: string; type: string; default?: string }[]; steps: unknown[] };
    const blob = JSON.stringify(workflow);
    assert.equal(blob.includes("SuperSecretPassword!"), false);
    assert.equal(blob.includes(file), false);
    assert.ok(workflow.inputs.some((input) => input.type === "secret"));
    assert.ok(workflow.inputs.some((input) => input.type === "file"));
    const secret = workflow.inputs.find((input) => input.type === "secret");
    const files = workflow.inputs.filter((input) => input.type === "file");
    const user = workflow.inputs.find((input) => input.name === "username");
    assert.ok(secret && user && files.length >= 1);
    for (const name of ["ada", "grace"]) {
      const args: Record<string, unknown> = {
        [user.name]: name,
        [secret.name]: "another-secret",
      };
      for (const input of files) args[input.name] = { name: "note.txt", path: file };
      const run = await post(app.port, "/api/replay", { id: workflow.id, args }) as {
        status: string;
        failure?: { reason: string; stepId: string };
        fileProof?: { action: string; name: string; via: string }[];
      };
      assert.equal(run.status, "passed", JSON.stringify(run.failure));
      assert.ok(run.fileProof?.some((item) => item.action === "upload" && item.name === "note.txt" && item.via === "input.files"), JSON.stringify(run.fileProof));
      assert.ok(run.fileProof?.some((item) => item.action === "drop" && item.name === "note.txt" && item.via === "echo"), JSON.stringify(run.fileProof));
    }
    const uiProfile = mkdtempSync(path.join(tmpdir(), "bao-ui-"));
    const ui = await launchOwnedChrome({ userDataDir: uiProfile, headless: true });
    try {
      const uiPage = ui.pages()[0] || await ui.newPage();
      await uiPage.goto(`http://127.0.0.1:${app.port}/`);
      await uiPage.click("button[data-screen=replay]");
      await uiPage.waitForSelector(".drop");
      const dropped = await uiPage.evaluate(() => {
        const zone = document.querySelector(".drop");
        if (!zone) return { span: "", name: "" };
        const dt = new DataTransfer();
        dt.items.add(new File(["hello"], "dragged-note.txt", { type: "text/plain" }));
        zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        const input = zone.querySelector("input") as HTMLInputElement | null;
        const span = zone.querySelector("span");
        return {
          span: span ? span.textContent || "" : "",
          name: input && input.files && input.files[0] ? input.files[0].name : "",
        };
      });
      assert.equal(dropped.span, "dragged-note.txt");
      assert.equal(dropped.name, "dragged-note.txt");
    } finally {
      await ui.close();
    }
    if (process.env.BAO_WRITE_EXAMPLES === "1") {
      const { writeFileSync: writeExample } = await import("node:fs");
      writeExample("examples/workflows/browser-form.json", JSON.stringify(app.library.read(workflow.id), null, 2));
    }
    const saved = app.library.read(workflow.id);
    const login = saved.steps.find((step) => step.identity?.testId === "login" || step.identity?.id === "login-btn");
    assert.ok(login);
    if (login.identity) {
      login.label = "Click missing control";
      login.intent = "missing control";
      delete login.anchor;
      delete login.locators;
      login.timeoutMs = 0;
      login.identity = { surface: "dom", role: "button", testId: "missing-login", path: [] };
    }
    app.library.save(saved);
    const broken = await post(app.port, "/api/replay", {
      id: workflow.id,
      args: { [user.name]: "ada", [secret.name]: "another-secret" },
    }) as { status: string; failure?: { reason: string; snapshot?: unknown } };
    assert.equal(broken.status, "failed");
    assert.ok(broken.failure?.snapshot);
    assert.equal(JSON.stringify(broken).includes("another-secret"), false);
    process.env.BAO_HEAL_FIXTURE = "1";
    const healedArgs: Record<string, unknown> = { [user.name]: "ada", [secret.name]: "another-secret" };
    for (const input of files) healedArgs[input.name] = { name: "note.txt", path: file };
    const healed = await post(app.port, "/api/replay", {
      id: workflow.id,
      args: healedArgs,
    }) as { status: string; heals?: { model?: { name?: string }; postconditionPassed?: boolean }[] };
    assert.equal(healed.status, "passed", JSON.stringify(healed));
    assert.equal(healed.heals?.[0]?.model?.name, "bao-heal-fixture");
    assert.equal(healed.heals?.[0]?.postconditionPassed, true);
    assert.ok(app.notices.some((notice) => notice.title.includes("healed")));
    delete process.env.BAO_HEAL_FIXTURE;
  } finally {
    await app.close();
  }
});
