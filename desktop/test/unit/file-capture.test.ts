import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileParamName, storedFileEvent } from "../../src/v1/file-chooser";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import type { Identity } from "../../src/v1/schema";

function id(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "input", path: [], ...partial };
}

test("a file param keeps the basename and drops the path", () => {
  assert.equal(fileParamName("/tmp/bao/alpha.txt"), "alpha.txt");
  assert.equal(fileParamName("alpha.txt"), "alpha.txt");
  assert.throws(() => fileParamName("/tmp/bao/.."), /file name/);
  const stored = storedFileEvent({
    op: "upload",
    fileName: "/tmp/bao/alpha.txt",
    rawPath: "/tmp/bao/alpha.txt",
  });
  assert.equal(stored.fileName, "alpha.txt");
  assert.equal(stored.rawPath, undefined);
  assert.equal(JSON.stringify(stored).includes("/tmp"), false);
});

test("a chooser click becomes a file input and the workflow has no path", () => {
  const events: TrailEvent[] = [
    {
      id: "c", ts: 1, kind: "act", op: "click",
      identity: id({ id: "file", testId: "file", tag: "input" }),
    },
    {
      id: "u", ts: 2, kind: "act", op: "upload", fileName: "alpha.txt", rawPath: "/tmp/bao/alpha.txt",
      identity: id({ id: "file", testId: "file", tag: "input" }),
    },
  ];
  const doc = interpret(events, { id: "wf-file", name: "File", startUrl: "http://127.0.0.1/fixture" });
  assert.equal(doc.steps.length, 1);
  assert.equal(doc.steps[0]?.action, "upload");
  assert.equal(doc.steps[0]?.input, "file");
  assert.equal(doc.inputs[0]?.type, "file");
  assert.equal(doc.inputs[0]?.default, undefined);
  const blob = JSON.stringify(doc);
  assert.equal(blob.includes("/tmp"), false);
  assert.equal(blob.includes("alpha.txt"), false);
});

test("a drop with a file name is a file input", () => {
  const doc = interpret([{
    id: "d", ts: 1, kind: "act", op: "drop", fileName: "beta.txt", rawPath: "/tmp/bao/beta.txt",
    identity: id({ id: "drop", testId: "drop", role: "region" }),
  }], { id: "wf-drop", name: "Drop", startUrl: "http://127.0.0.1/fixture" });
  assert.equal(doc.steps[0]?.action, "drop");
  assert.equal(doc.inputs[0]?.type, "file");
  assert.equal(doc.inputs[0]?.name, "file");
  assert.equal(doc.steps[0]?.value, "{{file}}");
  assert.equal(doc.steps[0]?.postcondition?.match, "Dropped file: {{file}}");
  assert.equal(JSON.stringify(doc).includes("/tmp/bao"), false);
});

test("the page recorder skips a file-input click and a path-shaped name", () => {
  const src = recorderSource();
  new Function(src);
  assert.match(src, /input\[type=file\]/);
  assert.match(src, /__baoSkipNextFile/);
  assert.match(src, /dataTransfer\.files/);
  assert.match(src, /dragover/);
  assert.match(src, /data-bao-drop/);
  assert.match(src, /parentElement/);
  assert.match(src, /dropHover/);
  assert.equal(src.includes("rawPath"), false);
  const client = readFileSync("desktop/src/app/client.ts", "utf8");
  assert.equal(client.includes("requestPermission"), false);
  assert.equal(client.includes("new Notification"), false);
});
