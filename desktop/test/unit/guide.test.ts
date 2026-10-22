// The shareable guide is one HTML file. A secret and a path stay out of it.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { startApp } from "../../src/app/server";
import { guideCrops, guideHtml } from "../../src/v1/guide";
import { readGuidePng } from "../../src/v1/guide-crop";
import { redactedPng } from "../../src/v1/redacted-png";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { shotFile, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";

const secret = "SuperSecretPassword!";
const file = "/Users/alex/notes.txt";
const home = "/home/alex/drop.txt";

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action" | "label">, index: number): WorkflowStep {
  return { surface: "dom", timeoutMs: 8000, index, ...partial };
}

test("an exported guide has placeholders and crops and no secret or absolute path", () => {
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: `Notes ${secret} ${home}`,
    startUrl: `file://${file}`,
    createdAt: 1,
    inputs: [
      { name: "username", type: "text", default: "demo" },
      { name: "password", type: "secret", default: secret },
      { name: "note", type: "text", default: "alpha note" },
      { name: "upload", type: "file", default: file },
      { name: "route", type: "choice", label: "Which way", choices: ["Log in first", "Already signed in", secret] },
    ],
    steps: [
      step({ id: "username", action: "type", label: `Type ${secret}`, input: "username", value: "demo" }, 0),
      step({ id: "password", action: "type", label: "Type secret", input: "password", value: secret, sensitive: true }, 1),
      step({ id: "note", action: "type", label: `Type {{note}} ${secret}`, input: "note", value: "alpha note" }, 2),
      step({ id: "upload", action: "upload", label: `Upload ${file}`, input: "upload", value: file }, 3),
      step({ id: "apply", action: "click", label: "Click Apply" }, 4),
      step({ id: "open", action: "click", label: `Open ${home}` }, 5),
      step({ id: "win", action: "click", label: "Open C:\\Users\\alex\\notes.txt" }, 6),
    ],
  };
  const crop = png(8, 8, [212, 83, 43]);
  assert.equal(crop.includes(Buffer.from(secret)), false);
  assert.equal(crop.includes(Buffer.from(file)), false);
  const crops = new Map<string, Buffer>([
    ["username", crop],
    ["password", crop],
    ["note", crop],
  ]);
  const html = guideHtml(doc, crops);
  assert.equal(html.includes(secret), false);
  assert.equal(html.includes(file), false);
  assert.equal(html.includes(home), false);
  assert.equal(html.includes("/Users/"), false);
  assert.equal(html.includes("/home/"), false);
  assert.equal(html.includes("file://"), false);
  assert.equal(html.includes("C:\\Users"), false);
  assert.equal(html.includes("demo"), false);
  assert.equal(html.includes("alpha note"), false);
  assert.equal(html.includes(doc.startUrl), false);
  assert.match(html, /\{\{username\}\}/);
  assert.match(html, /\{\{password\}\}/);
  assert.match(html, /\{\{note\}\}/);
  assert.match(html, /\{\{upload\}\}/);
  assert.match(html, /Log in first \/ Already signed in/);
  assert.match(html, /Type \{\{username\}\} in Username/);
  assert.match(html, /Type \{\{password\}\} in Password/);
  assert.match(html, /Type \{\{note\}\} in Note/);
  assert.match(html, /Click Apply/);
  assert.match(html, /data:image\/png;base64,/);
  assert.equal(html.split("data:image/png;base64,").length - 1, 3);
  assert.match(html, /id="guide"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script/i);
});

test("a focus click folds into the type step and recorded values stay out of the export", () => {
  const recorded = ["demo", "alpha note"];
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Sign in and apply",
    startUrl: "http://127.0.0.1:9/fixture",
    createdAt: 1,
    inputs: [
      { name: "username", type: "text", default: "demo" },
      { name: "password", type: "secret", default: secret },
      { name: "note", type: "text", default: "alpha note" },
    ],
    steps: [
      step({ id: "c-user", action: "click", label: "Click username", identity: field("username") }, 0),
      step({ id: "username", action: "type", label: "Type demo", input: "username", value: "demo", identity: field("username") }, 1),
      step({ id: "c-pass", action: "click", label: "Click password", identity: field("password") }, 2),
      step({ id: "password", action: "type", label: "Type secret", input: "password", value: secret, sensitive: true, identity: field("password") }, 3),
      step({ id: "login", action: "click", label: "Click Log in", identity: { surface: "dom", role: "button", tag: "button", text: "Log in", path: [] } }, 4),
      step({ id: "c-note", action: "click", label: "Click note", identity: field("note") }, 5),
      step({ id: "note", action: "type", label: "Type alpha note", input: "note", value: "alpha note", identity: field("note") }, 6),
      step({ id: "apply", action: "click", label: "Click Apply", identity: { surface: "dom", role: "button", tag: "button", text: "Apply", path: [] } }, 7),
      step({ id: "only-note", action: "click", label: "Click note", identity: field("note") }, 8),
    ],
  };
  const typed = textCrop(recorded[0]);
  const secretShot = maskCrop();
  const plain = png(40, 28, [255, 255, 255]);
  assert.equal(typed.includes(Buffer.from("demo")), true);
  assert.equal(typed.includes(Buffer.from("alpha note")), true);
  const html = guideHtml(doc, new Map([
    ["username", typed],
    ["password", secretShot],
    ["note", textCrop("alpha note")],
    ["apply", plain],
    ["only-note", plain],
  ]));
  assert.equal((html.match(/<li class="step"/g) || []).length, 6);
  assert.match(html, /Type \{\{username\}\} in Username/);
  assert.match(html, /Type \{\{password\}\} in Password/);
  assert.match(html, /Click Log in/);
  assert.match(html, /Type \{\{note\}\} in Note/);
  assert.match(html, /Click Apply/);
  assert.match(html, /Click the Note field/);
  assert.equal(html.includes("Click username"), false);
  assert.equal(html.includes("Click password"), false);
  assert.equal(html.includes("Click note"), false);
  for (const value of [...recorded, secret, "demo-pass"]) assert.equal(html.includes(value), false, value);
  const images = [...html.matchAll(/data:image\/png;base64,([^"]+)/g)].map((match) => Buffer.from(match[1], "base64"));
  assert.equal(images.length, 5);
  const username = readGuidePng(images[0]);
  assert.ok(username);
  assert.equal(countColor(username, (r, g, b) => g > 200 && r < 40 && b < 40), 0);
  assert.ok(countColor(username, (r, g, b) => r > 180 && r > g + 40 && b < 100) > 20);
  const password = readGuidePng(images[1]);
  assert.ok(password);
  const edge = 20 * password.width * 4;
  assert.ok(password.rgba[edge] > 200, "password mask overflows the card");
  assert.equal(countColor(password, (r, g, b) => r < 20 && g < 20 && b < 20), 0);
  assert.ok(countColor(password, (r, g, b) => r > 90 && r < 140 && g > 90 && g < 140) > 4);
  assert.ok(countColor(password, (r, g, b) => r > 180 && r > g + 40 && b < 100) > 20);
  const apply = readGuidePng(images[3]);
  assert.ok(apply);
  assert.ok(countColor(apply, (r, g, b) => r > 180 && r > g + 40 && b < 100) > 20);
});

function field(name: string): WorkflowStep["identity"] {
  return { surface: "dom", role: "input", tag: "input", id: name, nameAttr: name, path: [] };
}

function textCrop(value: string): Buffer {
  const image = png(48, 36, [255, 255, 255]);
  const painted = paintRect(image, 8, 22, 32, 8, [0, 255, 0]);
  return withText(painted, `${value} alpha note`);
}

function maskCrop(): Buffer {
  const image = png(48, 36, [245, 245, 247]);
  return paintRect(image, 0, 16, 48, 14, [0, 0, 0]);
}

function paintRect(image: Buffer, x: number, y: number, w: number, h: number, rgb: [number, number, number]): Buffer {
  const decoded = readGuidePng(image);
  if (!decoded) throw new Error("png");
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = (row * decoded.width + col) * 4;
      decoded.rgba[i] = rgb[0];
      decoded.rgba[i + 1] = rgb[1];
      decoded.rgba[i + 2] = rgb[2];
    }
  }
  return encodeRgb(decoded.width, decoded.height, decoded.rgba);
}

function withText(image: Buffer, text: string): Buffer {
  const iend = image.lastIndexOf(Buffer.from("IEND"));
  const chunk = textChunk(text);
  return Buffer.concat([image.subarray(0, iend - 4), chunk, image.subarray(iend - 4)]);
}

function textChunk(text: string): Buffer {
  const data = Buffer.concat([Buffer.from("Comment"), Buffer.from([0]), Buffer.from(text)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from("tEXt"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodeRgb(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dest = row + 1 + x * 3;
      raw[dest] = rgba[src];
      raw[dest + 1] = rgba[src + 1];
      raw[dest + 2] = rgba[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function countColor(image: { width: number; height: number; rgba: Uint8Array }, match: (r: number, g: number, b: number) => boolean): number {
  let count = 0;
  for (let i = 0; i < image.width * image.height * 4; i += 4) {
    if (match(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) count += 1;
  }
  return count;
}

test("guide crops keep a redacted secret step and skip a full-page stripe", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-guide-"));
  const library = new Library(root);
  const doc = saved(library);
  library.savePublicInputs(doc.id, {
    username: "demo",
    password: secret,
    note: "alpha note",
    upload: file,
  });
  writeFileSync(path.join(root, "runs", "run-1.json"), JSON.stringify({
    id: "run-1",
    workflowId: doc.id,
    at: 2,
    inputs: { password: secret, upload: home },
  }));
  const shotDir = path.join(root, "shots", "workflows", doc.id);
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(path.join(root, "shots", "runs", "run-1"), { recursive: true });
  writeFileSync(path.join(shotDir, workflowShotName("username")), png(8, 8, [20, 40, 60]));
  writeFileSync(path.join(shotDir, workflowShotName("password")), png(8, 8, [30, 50, 70]));
  writeFileSync(path.join(shotDir, workflowShotName("note")), redactedPng(1));
  writeFileSync(path.join(root, "shots", "runs", "run-1", shotFile("note", "after")), png(8, 8, [40, 60, 80]));
  const crops = guideCrops(root, doc);
  assert.equal(crops.has("username"), true);
  assert.equal(crops.has("password"), true);
  assert.equal(crops.has("note"), true);
  assert.equal(crops.has("apply"), false);
  const html = guideHtml(doc, crops);
  assert.equal(html.includes(secret), false);
  assert.equal(html.includes(file), false);
  assert.equal(html.includes(home), false);
  assert.equal(html.includes(root), false);
  assert.equal(html.includes("/tmp/"), false);
  assert.equal(html.includes("alpha note"), false);
  assert.equal(html.includes("demo"), false);
  assert.match(html, /Type \{\{password\}\}/);
  assert.match(html, /Type \{\{username\}\}/);
  assert.match(html, /Click Apply/);
});

test("GET /guide returns the page and leaves the secret file unread", { timeout: 60000 }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "bao-guide-http-"));
  const previous = process.env.BAO_CHROME_USER_DATA;
  process.env.BAO_CHROME_USER_DATA = path.join(homeDir, "no-chrome");
  const app = await startApp({ home: homeDir, port: 0 });
  try {
    const doc = saved(app.library);
    app.library.savePublicInputs(doc.id, { password: secret, upload: file });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/workflows/${doc.id}/guide`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(html.includes(secret), false);
    assert.equal(html.includes(file), false);
    assert.equal(html.includes(homeDir), false);
    assert.equal(html.includes("alpha note"), false);
    assert.match(html, /id="guide"/);
    assert.match(html, /\{\{password\}\}/);
    const missing = await fetch(`http://127.0.0.1:${app.port}/api/workflows/missing/guide`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previous;
  }
});

function saved(library: Library): WorkflowV2 {
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "guide-wf",
    name: "Sign in and apply",
    startUrl: "http://127.0.0.1:9/fixture",
    createdAt: 1,
    inputs: [
      { name: "username", type: "text", default: "demo" },
      { name: "password", type: "secret" },
      { name: "note", type: "text", default: "alpha note" },
      { name: "upload", type: "file" },
    ],
    steps: [
      step({ id: "username", action: "type", label: "Type {{username}}", input: "username", value: "{{username}}" }, 0),
      step({ id: "password", action: "type", label: "Type secret", input: "password", value: "{{password}}", sensitive: true }, 1),
      step({ id: "note", action: "type", label: "Type {{note}}", input: "note", value: "{{note}}" }, 2),
      step({ id: "apply", action: "click", label: "Click Apply" }, 3),
    ],
  };
  library.save(doc);
  return doc;
}
