import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";

test("the notch shows the step sentence, not a tab list taken for a picture", async () => {
  const proxy = new AgentBrowserProxy({ home: mkdtempSync(path.join(tmpdir(), "bao-notch-")) });
  const lines: string[] = [];
  const session = {
    kind: "copy",
    abort: new AbortController(),
    snapshots: new Map<string, string>([["-i", '- button "Add to cart" [ref=e1]\n']]),
    daemonStarted: true,
    executable: process.execPath,
    flags: ["-e", "process.exit(0)", "--"],
    stateDir: tmpdir(),
    env: process.env,
  };
  const internal = proxy as unknown as {
    shown: { session: object; command: string };
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
  internal.shown = { session, command: "snapshot" };
  await internal.run(session, "tab", ["list", "--json"]);
  await internal.run(session, "snapshot", ["-i"]);
  internal.shown = { session, command: "click" };
  await internal.run(session, "click", ["@e1"]);
  await internal.run(session, "tab", ["list", "--json"]);
  assert.deepEqual(lines, ["Read the page", "Click Add to cart"]);
});
