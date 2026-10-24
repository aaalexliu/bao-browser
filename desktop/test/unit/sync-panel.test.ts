import assert from "node:assert/strict";
import test from "node:test";
import { syncPanel } from "../../src/app/logins-view";

test("the sync status counts the conflicts still listed", () => {
  const html = syncPanel({
    paired: true,
    lastResult: "pushed 1, pulled 0, conflicts 0",
    conflicts: [{ id: "cross-mac", remoteVersion: 2, file: "conflicts/cross-mac.json" }],
  });
  assert.match(html, /data-testid="sync-result">pushed 1, pulled 0, conflicts 1</);
  assert.match(html, /data-testid="conflict"/);
  assert.match(html, /cross-mac/);
});

test("an empty conflict list stays at zero", () => {
  const html = syncPanel({ paired: true, lastResult: "pushed 1, pulled 0, conflicts 0", conflicts: [] });
  assert.match(html, /conflicts 0/);
  assert.equal(html.includes(">Conflicts<"), false);
});

test("a refused push keeps its message when an older conflict is still listed", () => {
  const html = syncPanel({
    paired: true,
    lastResult: "Push refused: secret param",
    conflicts: [{ id: "cross-mac", remoteVersion: 2, file: "conflicts/cross-mac.json" }],
  });
  assert.match(html, /data-testid="sync-result">Push refused: secret param</);
  assert.match(html, /data-testid="conflict"/);
});
