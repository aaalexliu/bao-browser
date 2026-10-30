import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent, AuditSource } from "../../src/proxy/audit";
import { interpretOs } from "../../src/proxy/interpret-os";

const source: AuditSource = { agent: "live-model", vendor: "cursor", adapter: "gpt-6-astra" };

test("live calculator trail drops three Clear presses and keeps {{a}} Add {{b}} Equals", () => {
  const events: AuditEvent[] = [
    shot(),
    click("All Clear"),
    click("Clear"),
    click("AC"),
    shot(),
    click("7"),
    click("Add"),
    click("5"),
    click("Equals"),
  ];
  const result = interpretOs(events, "calc");
  assert.equal(result.screenshots, 2);
  assert.deepEqual(result.workflow.steps.map((step) => step.os?.target.name), ["{{a}}", "Add", "{{b}}", "Equals"]);
  assert.deepEqual(result.workflow.variables, ["a", "b"]);
  assert.equal(JSON.stringify(result.workflow).includes("All Clear"), false);
});

test("live textedit trail keeps one osSetValue of {{text}}", () => {
  const events: AuditEvent[] = [
    shot(),
    value("hello"),
    value("hello from bao"),
    click("ignored"),
  ];
  const result = interpretOs(events, "textedit");
  assert.equal(result.workflow.steps.length, 1);
  assert.equal(result.workflow.steps[0]?.action, "osSetValue");
  assert.equal(result.workflow.steps[0]?.os?.value, "{{text}}");
  assert.deepEqual(result.workflow.variables, ["text"]);
  assert.deepEqual(result.workflow.steps[0]?.os?.target.path, []);
});

function shot(): AuditEvent {
  return { id: "s", ts: 1, kind: "read", op: "screenshot", source, raw: {} };
}

function click(name: string): AuditEvent {
  return {
    id: name,
    ts: 2,
    kind: "act",
    op: "osClick",
    source,
    raw: {},
    os: { platform: "macos", app: "Calculator", role: "AXButton", name, path: [] },
  };
}

function value(text: string): AuditEvent {
  return {
    id: text,
    ts: 3,
    kind: "act",
    op: "osSetValue",
    source,
    raw: {},
    os: {
      platform: "macos",
      app: "TextEdit",
      role: "AXTextArea",
      name: "First Text View",
      identifier: "First Text View",
      path: [{ role: "AXWindow", name: "Untitled" }],
      value: text,
    },
  };
}
