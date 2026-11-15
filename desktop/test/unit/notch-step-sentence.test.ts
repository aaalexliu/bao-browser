import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";

test("the notch shows the step sentence, not a tab list taken for a picture or after the step", async () => {
  const proxy = new AgentBrowserProxy({ home: mkdtempSync(path.join(tmpdir(), "bao-notch-")) });
  const lines: string[] = [];
  const session = {
    kind: "copy",
    abort: new AbortController(),
    recording: { id: "run-notch" },
    daemonStarted: true,
    executable: process.execPath,
    flags: ["-e", "process.exit(0)", "--"],
    stateDir: tmpdir(),
    env: process.env,
  };
  interface Step { native: { command: string }; caption: { text: string }; endedAt?: number }
  const internal = proxy as unknown as {
    shown: { session: object; command: string };
    latest: { runId: string; step: Step };
    takeover: { held: boolean; stoppedByOwner: boolean; waitConfirm(): Promise<void>; activityLine(text: string): Promise<void>; bracket<T>(fn: () => Promise<T>): Promise<T>; hideForShot<T>(fn: () => Promise<T>): Promise<T> };
    run(session: object, command: string, args: string[]): Promise<unknown>;
  };
  internal.takeover = {
    held: false,
    stoppedByOwner: false,
    async waitConfirm() {},
    async activityLine(text: string) { lines.push(text); },
    async bracket(fn) { return fn(); },
    async hideForShot(fn) { return fn(); },
  };
  const begin = (command: string, text: string): Step => {
    const step = { native: { command }, caption: { text } };
    internal.shown = { session, command };
    internal.latest = { runId: "run-notch", step };
    return step;
  };
  begin("snapshot", "Read the page");
  await internal.run(session, "tab", ["list", "--json"]);
  await internal.run(session, "snapshot", ["-i"]);
  begin("click", "Click Add to cart");
  await internal.run(session, "click", ["@e1"]);
  await internal.run(session, "tab", ["list", "--json"]);
  const opened = begin("tab", "Opened a new tab");
  await internal.run(session, "tab", ["new"]);
  opened.endedAt = Date.now();
  await internal.run(session, "tab", ["list", "--json"]);
  assert.deepEqual(lines, ["Read the page", "Click Add to cart", "Opened a new tab"]);
});
