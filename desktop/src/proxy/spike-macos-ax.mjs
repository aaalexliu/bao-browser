// Dump redacted Accessibility fixtures and try the open panel plus a CGEvent drag.
// Throws away only processes this script started. Finder stays up; only the temp window is closed.

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = (process.env.BAO_MAC_SPIKE_ROOT || "").trim()
  || path.resolve(import.meta.dirname, "../../..");
const HELPER = path.join(ROOT, "desktop/os-helper-macos/BaoOSHelper.app");
const FIXTURES = path.join(ROOT, "fixtures/ax/macos-26");

function artifactsDir() {
  const explicit = (process.env.BAO_SPIKE_ARTIFACTS || "").trim();
  if (explicit) return explicit;
  const store = (process.env.BAO_AGENT_STORE_DIR || "").trim();
  if (store) return path.join(store, "bao-mac-spike");
  throw new Error("Set BAO_SPIKE_ARTIFACTS or BAO_AGENT_STORE_DIR");
}

const BIN = {
  pgrep: "/usr/bin/pgrep",
  open: "/usr/bin/open",
  kill: "/bin/kill",
  plutil: "/usr/bin/plutil",
};

const CALC = "com.apple.calculator";
const EDIT = "com.apple.TextEdit";
const FINDER = "com.apple.finder";
const SAFARI = "com.apple.Safari";
const FINDER_DIR = "/tmp/bao-ax-finder";
const OPEN_FILE = "/tmp/bao-ax-open/note.txt";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrub(value) {
  const user = process.env.USER || "";
  const walk = (item) => {
    if (typeof item === "string") {
      let text = item;
      if (user.length >= 3) text = text.split(user).join("[user]");
      text = text.replace(/\/Users\/[^/\s]+/g, "[home]");
      text = text.replace(/\/private\/var\/folders\/\S+/g, "[redacted-path]");
      return text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const out = {};
      for (const [key, child] of Object.entries(item)) out[key] = walk(child);
      return out;
    }
    return item;
  };
  return walk(value);
}

function exec(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function pidsOf(name) {
  const { code, stdout } = await exec(BIN.pgrep, ["-x", name]);
  if (code !== 0) return [];
  return stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => pid > 0);
}

async function helper(args, timeoutMs = 30000) {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-os-"));
  const stdout = path.join(dir, "out.json");
  const stderr = path.join(dir, "err.txt");
  const result = path.join(dir, "result.json");
  const started = Date.now();
  try {
    const child = spawn(BIN.open, [
      "-n", "-W", "-g", "-a", HELPER,
      "--stdout", stdout, "--stderr", stderr,
      "--args", ...args, "--result", result,
    ], { stdio: "ignore" });
    let closed;
    child.on("error", () => { closed = -1; });
    child.on("close", (code) => { closed = code ?? -1; });
    let out = "";
    while (Date.now() - started < timeoutMs) {
      out = await readFile(result, "utf8").catch(() => "");
      if (!out.trim()) out = await readFile(stdout, "utf8").catch(() => "");
      if (out.trim()) break;
      if (typeof closed === "number" && closed !== 0) break;
      await sleep(80);
    }
    const err = await readFile(stderr, "utf8").catch(() => "");
    if (!out.trim()) throw new Error(scrub(err.trim() || `no result for ${args[0]}`));
    const parsed = JSON.parse(out);
    if (parsed.ok === false) throw new Error(scrub(parsed.error || `${args[0]} failed`));
    return scrub(parsed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function launchIfDown(app, processName) {
  const before = await pidsOf(processName);
  if (before.length > 0) return null;
  const opened = await exec(BIN.open, ["-a", app]);
  if (opened.code !== 0) throw new Error(`open failed for ${processName}`);
  for (let i = 0; i < 40; i++) {
    const now = await pidsOf(processName);
    const owned = now.find((pid) => !before.includes(pid));
    if (owned) return owned;
    await sleep(250);
  }
  throw new Error(`${processName} did not start`);
}

async function quitOwned(pid, processName) {
  if (pid == null) return;
  const live = await pidsOf(processName);
  if (!live.includes(pid)) return;
  await exec(BIN.kill, [String(pid)]);
  for (let i = 0; i < 20; i++) {
    if (!(await pidsOf(processName)).includes(pid)) return;
    await sleep(150);
  }
  await exec(BIN.kill, ["-KILL", String(pid)]);
}

async function dumpFixture(bundle, title, out, extra = []) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      last = await helper(["fixture", "--bundle", bundle, "--title", title, "--out", out, ...extra], 120000);
      if ((last.nodeCount ?? 0) > 1) return last;
    } catch (err) {
      last = { error: scrub(err.message) };
    }
    await sleep(400);
  }
  if (last && last.error) throw new Error(last.error);
  return last;
}

function names(doc, role) {
  const found = new Set();
  for (const node of doc.nodes || []) {
    if (node.role === role && node.title) found.add(node.title);
    if (node.role === role && node.description) found.add(node.description);
    if (node.role === role && node.identifier) found.add(node.identifier);
  }
  return [...found].sort();
}

function sampleNames(doc, role) {
  const found = new Set();
  for (const row of doc.samples || []) {
    if (row.role === role && row.name) found.add(row.name);
  }
  return [...found].sort();
}

async function identity(file) {
  const doc = JSON.parse(await readFile(file, "utf8"));
  const inTree = new Set(names(doc, "AXButton"));
  const sampled = sampleNames(doc, "AXButton");
  const onlySamples = sampled.filter((name) => !inTree.has(name) && ![...inTree].some((title) => title === name));
  const titled = (doc.nodes || []).filter((node) => node.role === "AXWindow").map((node) => node.title);
  return {
    nodeCount: doc.nodeCount,
    sampleCount: doc.sampleCount,
    truncated: doc.truncated,
    manualAccessibility: doc.manualAccessibility,
    windowTitles: titled,
    buttonCount: (doc.nodes || []).filter((node) => node.role === "AXButton").length,
    buttonsMissingFromTree: onlySamples.slice(0, 30),
    textRoles: [...new Set((doc.nodes || []).filter((node) => ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"].includes(node.role)).map((node) => `${node.role}:${node.title || node.description || node.identifier || ""}`))].slice(0, 20),
  };
}

function frameNamed(doc, name) {
  const hits = (doc.nodes || []).filter((node) => node.frame && (node.title === name || node.description === name || node.identifier === name || node.label === name || node.value === name));
  hits.sort((a, b) => (a.frame.w * a.frame.h) - (b.frame.w * b.frame.h));
  const text = hits[0]?.frame || null;
  if (!text) return null;
  const icon = (doc.nodes || []).find((node) => node.role === "AXImage" && node.frame && node.frame.x < text.x && text.x - node.frame.x < 40 && Math.abs(node.frame.y - text.y) < 12);
  return icon?.frame || text;
}

function frameRole(doc, role) {
  const hits = (doc.nodes || []).filter((node) => node.role === role && node.frame);
  hits.sort((a, b) => (b.frame.w * b.frame.h) - (a.frame.w * a.frame.h));
  return hits[0]?.frame || null;
}

async function readText() {
  const hit = await helper(["read", "--bundle", EDIT, "--role", "AXTextArea", "--name", "First Text View"]);
  return String(hit.value || "");
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: scrub(err.message || String(err)) };
  }
}

function classify(value) {
  const text = String(value || "");
  const trimmed = text.trim();
  if (text.includes("bao ax open")) return { result: "opened-test-file" };
  if (text.includes("bao ax drag")) return { result: "shows-drag-text" };
  if (text.includes("bao ax a")) return { result: "shows-finder-file" };
  if (text.includes("/tmp/bao-ax-")) return { result: "path-typed-into-document" };
  if (trimmed === "") return { result: "empty" };
  if (["bao mac spike", "hello from bao", "alpha one", "beta two"].includes(trimmed)) return { result: "previous-spike-text" };
  return { result: "non-test-value-omitted" };
}

async function pressNamed(name) {
  try {
    await helper(["press", "--bundle", EDIT, "--role", "AXButton", "--name", name]);
    return { pressed: name, ok: true };
  } catch (err) {
    return { pressed: name, ok: false, error: scrub(err.message) };
  }
}

async function ensureUntitled(ownedPid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const brief = await helper(["windows-brief", "--bundle", EDIT, "--allow", "Untitled"]);
    const titles = (brief.windows || []).map((row) => row.title);
    if (titles.includes("[omitted]")) {
      await quitOwned(ownedPid, "TextEdit");
      throw new Error("restored document; aborting without reading it");
    }
    if (brief.openPanel && !titles.some((title) => String(title).startsWith("Untitled"))) {
      const pressed = await pressNamed("New Document");
      if (!pressed.ok) throw new Error(pressed.error || "New Document press failed");
      await sleep(400);
      continue;
    }
    if (titles.some((title) => String(title).startsWith("Untitled"))) return brief;
    await sleep(250);
  }
  throw new Error("TextEdit opened no untitled window");
}

async function main() {
  const report = { permissions: null, apps: {}, openPanel: null, drag: null };
  const owned = { Calculator: null, TextEdit: null, Safari: null, Electron: null };
  const artifacts = artifactsDir();
  await mkdir(FIXTURES, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  try {
    const perms = await helper(["permissions"]);
    report.permissions = {
      accessibility: perms.accessibility === true,
      screenCapture: perms.screenCapture === true,
      prompted: perms.prompted === true,
      parentIsLaunchd: perms.ppid === 1,
    };
    if (!report.permissions.accessibility || !report.permissions.screenCapture) {
      throw new Error("permission check failed inside BaoOSHelper; stopping without a prompt");
    }

    report.apps.calculator = await guard(async () => {
      owned.Calculator = await launchIfDown("Calculator", "Calculator");
      if (owned.Calculator == null) return { skipped: "already running" };
      await sleep(900);
      const out = path.join(FIXTURES, "calculator.json");
      const dumped = { ...(await dumpFixture(CALC, "Calculator", out)), ...(await identity(out)) };
      await quitOwned(owned.Calculator, "Calculator");
      owned.Calculator = null;
      return dumped;
    });

    report.apps.textedit = await guard(async () => {
      owned.TextEdit = await launchIfDown("TextEdit", "TextEdit");
      if (owned.TextEdit == null) return { skipped: "already running" };
      await sleep(700);
      await ensureUntitled(owned.TextEdit);
      const kind = classify(await readText());
      if (kind.result === "non-test-value-omitted") {
        await quitOwned(owned.TextEdit, "TextEdit");
        owned.TextEdit = null;
        return { error: "untitled window had non-test content; tree was not written" };
      }
      if (kind.result !== "empty") {
        await helper(["set-value", "--bundle", EDIT, "--role", "AXTextArea", "--name", "First Text View", "--value", ""]);
      }
      const out = path.join(FIXTURES, "textedit.json");
      return { ...(await dumpFixture(EDIT, "Untitled", out)), ...(await identity(out)) };
    });

    report.apps.finder = await guard(async () => {
      await mkdir(FINDER_DIR, { recursive: true });
      await writeFile(path.join(FINDER_DIR, "a.txt"), "bao ax a\n");
      await writeFile(path.join(FINDER_DIR, "b.txt"), "bao ax b\n");
      const openedFinder = await exec(BIN.open, [FINDER_DIR]);
      if (openedFinder.code !== 0) return { error: "open temp folder failed" };
      await sleep(900);
      const out = path.join(FIXTURES, "finder.json");
      return { ...(await dumpFixture(FINDER, "bao-ax-finder", out, ["--focused"])), ...(await identity(out)) };
    });

    owned.Safari = null;
    report.apps.safari = await guard(async () => {
    const safariPid = await launchIfDown("Safari", "Safari");
    const startedSafari = safariPid != null;
    owned.Safari = startedSafari ? safariPid : null;
    if (startedSafari) await sleep(1200);
      const keyPath = [];
      try {
        await helper(["key", "--bundle", SAFARI, "--combo", "cmd+shift+n"]);
        keyPath.push("ax-private");
      } catch (err) {
        keyPath.push(`ax-private-failed:${scrub(err.message)}`);
      }
      await sleep(500);
      try {
        await helper(["cg-key", "--bundle", SAFARI, "--combo", "cmd+shift+n"]);
        keyPath.push("cg-private");
      } catch (err) {
        keyPath.push(`cg-private-failed:${scrub(err.message)}`);
      }
      await sleep(700);
      let addressed = false;
      try {
        await helper(["key", "--bundle", SAFARI, "--combo", "cmd+l"]);
        await sleep(200);
        await helper(["type-keys", "--bundle", SAFARI, "--text", "https://the-internet.herokuapp.com"], 20000);
        await helper(["key", "--bundle", SAFARI, "--combo", "return"]);
        addressed = true;
        keyPath.push("ax-url");
      } catch (err) {
        keyPath.push(`ax-url-failed:${scrub(err.message)}`);
      }
      if (!addressed) {
        await helper(["cg-key", "--bundle", SAFARI, "--combo", "cmd+l"]);
        await sleep(200);
        await helper(["cg-type", "--bundle", SAFARI, "--text", "https://the-internet.herokuapp.com"], 20000);
        await helper(["cg-key", "--bundle", SAFARI, "--combo", "return"]);
        keyPath.push("cg-url");
      }
      let ready = false;
      for (let i = 0; i < 25; i += 1) {
        const brief = await helper(["windows-brief", "--bundle", SAFARI, "--allow", "Internet"]);
        const titles = (brief.windows || []).map((row) => row.title);
        if (titles.some((title) => String(title).includes("Internet") && title !== "[omitted]")) {
          ready = true;
          break;
        }
        await sleep(500);
      }
      const dumped = ready
        ? { ...(await dumpFixture(SAFARI, "Internet", path.join(FIXTURES, "safari.json"), ["--focused"])), ...(await identity(path.join(FIXTURES, "safari.json"))) }
        : { error: "test page title did not appear" };
      let closedTestWindow = false;
      let closeError = null;
      try {
        await helper(["close-window", "--bundle", SAFARI, "--title", "Internet"]);
        closedTestWindow = true;
      } catch (err) {
        closeError = scrub(err.message);
      }
      const left = await helper(["windows-brief", "--bundle", SAFARI, "--allow", "Internet"]).catch(() => null);
      const omitted = (left?.windows || []).some((row) => row.title === "[omitted]");
      if (!omitted && startedSafari) {
        await quitOwned(owned.Safari, "Safari");
        owned.Safari = null;
      }
      return { ...dumped, keyPath, closedTestWindow, closeError, leftRunning: omitted || !startedSafari ? "other windows were left open" : false };
    });

    const electronBin = path.join(ROOT, "fixtures/ax/electron-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    const electronAlready = await pidsOf("Electron");
    if (electronAlready.length > 0) {
      report.apps.electron = { skipped: "Electron process already running" };
    } else {
      try {
        await access(electronBin);
      } catch {
        report.apps.electron = { error: "throwaway Electron binary is missing" };
      }
    }
    if (!report.apps.electron) report.apps.electron = await guard(async () => {
      const plist = path.join(ROOT, "fixtures/ax/electron-app/node_modules/electron/dist/Electron.app/Contents/Info.plist");
      const bundle = (await exec(BIN.plutil, ["-extract", "CFBundleIdentifier", "raw", plist])).stdout.trim();
      const child = spawn(electronBin, [path.join(ROOT, "fixtures/ax/electron-app")], { stdio: "ignore", detached: true });
      child.unref();
      owned.Electron = child.pid;
      await sleep(1500);
      const off = path.join(FIXTURES, "electron-manual-off.json");
      const on = path.join(FIXTURES, "electron.json");
      let manualOff = null;
      try {
        manualOff = await helper(["fixture", "--bundle", bundle, "--out", off, "--manual", "off"], 120000);
        manualOff = { ...manualOff, ...(await identity(off)) };
      } catch (err) {
        manualOff = { error: scrub(err.message) };
      }
      const manualOn = { ...(await helper(["fixture", "--bundle", bundle, "--out", on], 120000)), ...(await identity(on)) };
      await quitOwned(owned.Electron, "Electron");
      owned.Electron = null;
      return { bundle, manualOff, manualOn };
    });

    if (owned.TextEdit != null && !report.apps.textedit?.skipped) {
      report.openPanel = await guard(() => runOpenPanel());
      report.drag = await guard(() => runDrag());
    }
  } finally {
    try {
      await helper(["close-window", "--bundle", FINDER, "--title", "bao-ax-finder"]);
    } catch {
      // The temp window may already be gone.
    }
    if (owned.TextEdit != null) {
      await helper(["key", "--bundle", EDIT, "--combo", "cmd+w"]).catch(() => {});
      await sleep(300);
      await pressNamed("Don't Save");
      await pressNamed("Delete");
      await quitOwned(owned.TextEdit, "TextEdit");
    }
    await quitOwned(owned.Calculator, "Calculator");
    await quitOwned(owned.Electron, "Electron");
    await rm(FINDER_DIR, { recursive: true, force: true });
    await rm("/tmp/bao-ax-open", { recursive: true, force: true });
    const safe = scrub(report);
    const dropPaths = (item) => {
      if (Array.isArray(item)) item.forEach(dropPaths);
      else if (item && typeof item === "object") {
        delete item.path;
        Object.values(item).forEach(dropPaths);
      }
    };
    dropPaths(safe);
    await writeFile(path.join(FIXTURES, "files.json"), JSON.stringify(safe, null, 2) + "\n");
    await writeFile(path.join(artifacts, "ax-macos-26-report.json"), JSON.stringify(safe, null, 2) + "\n");
  }
}

async function runOpenPanel() {
  const before = classify(await readText());
  if (before.result === "non-test-value-omitted") {
    return { before, after: before, steps: [], blocked: "untitled window had non-test content; no keys were sent" };
  }
  await mkdir("/tmp/bao-ax-open", { recursive: true });
  await writeFile(OPEN_FILE, "bao ax open\n");
  const steps = [];
  const record = async (name, fn) => {
    try {
      const value = await fn();
      steps.push({ name, ok: true, ...(value || {}) });
    } catch (err) {
      steps.push({ name, ok: false, error: scrub(err.message) });
    }
  };
  await record("cmd+o", async () => {
    await helper(["key", "--bundle", EDIT, "--combo", "cmd+o"]);
    await sleep(600);
    return helper(["windows-brief", "--bundle", EDIT, "--allow", "Untitled"]);
  });
  await record("cmd+shift+g", async () => {
    await helper(["key", "--bundle", EDIT, "--combo", "cmd+shift+g"]);
    await sleep(400);
    return helper(["windows-brief", "--bundle", EDIT, "--allow", "Untitled"]);
  });
  await record("type-path", async () => {
    await helper(["type-keys", "--bundle", EDIT, "--text", OPEN_FILE], 20000);
    return {};
  });
  await record("return", async () => {
    await helper(["key", "--bundle", EDIT, "--combo", "return"]);
    await sleep(700);
    return {};
  });
  let after = classify(await readText().catch(() => ""));
  const axMissed = after.result !== "opened-test-file" && after.result !== "path-typed-into-document";
  if (axMissed && before.result !== "non-test-value-omitted") {
    await record("cg-cmd+o", async () => {
      await helper(["cg-key", "--bundle", EDIT, "--combo", "cmd+o"]);
      await sleep(600);
      return helper(["windows-brief", "--bundle", EDIT, "--allow", "Untitled"]);
    });
    await record("cg-cmd+shift+g", async () => {
      await helper(["cg-key", "--bundle", EDIT, "--combo", "cmd+shift+g"]);
      await sleep(400);
      return helper(["windows-brief", "--bundle", EDIT, "--allow", "Untitled"]);
    });
    await record("cg-type-path", async () => {
      await helper(["cg-type", "--bundle", EDIT, "--text", OPEN_FILE], 20000);
      return {};
    });
    await record("cg-return", async () => {
      await helper(["cg-key", "--bundle", EDIT, "--combo", "return"]);
      await sleep(700);
      return {};
    });
    after = classify(await readText().catch(() => ""));
  }
  if (after.result !== "opened-test-file") {
    const pressed = await pressNamed("Open");
    steps.push({ name: "press-open", ...pressed });
    await sleep(700);
    after = classify(await readText().catch(() => ""));
  }
  return { before, after, steps };
}

async function runDrag() {
  const finder = JSON.parse(await readFile(path.join(FIXTURES, "finder.json"), "utf8"));
  const edit = JSON.parse(await readFile(path.join(FIXTURES, "textedit.json"), "utf8"));
  const source = frameNamed(finder, "a.txt");
  let target = frameRole(edit, "AXTextArea");
  if (!source || !target) return { skipped: "missing source or target frame" };
  const fresh = await helper(["read", "--bundle", EDIT, "--role", "AXTextArea", "--name", "First Text View"]).catch(() => null);
  if (fresh?.element?.frame) target = fresh.element.frame;
  const from = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const to = { x: target.x + Math.min(target.w / 2, 80), y: target.y + Math.min(target.h / 2, 40) };
  const dragged = await helper([
    "drag",
    "--from-x", String(Math.round(from.x)),
    "--from-y", String(Math.round(from.y)),
    "--to-x", String(Math.round(to.x)),
    "--to-y", String(Math.round(to.y)),
  ], 20000);
  await sleep(500);
  const after = classify(await readText().catch(() => ""));
  return {
    from: { x: Math.round(from.x), y: Math.round(from.y) },
    to: { x: Math.round(to.x), y: Math.round(to.y) },
    delivered: dragged.delivered === true,
    blocked: dragged.blocked === true,
    landed: dragged.landed === true,
    coordinateSpace: dragged.coordinateSpace || null,
    cursorBefore: dragged.cursorBefore || null,
    cursorAfter: dragged.cursorAfter || dragged.cursorAfterBottomLeftPost || null,
    valueAfter: after,
  };
}

main().catch(async (err) => {
  process.stderr.write(`${scrub(err && err.stack ? err.stack : err)}\n`);
  process.exitCode = 1;
});
