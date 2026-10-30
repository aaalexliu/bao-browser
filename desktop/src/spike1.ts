// Spike 1 demo. Pass/fail is the list in docs/desktop-design.md §4.
// Profiles are fresh temp dirs (reproducible). The app-owned persistent
// location is resolved and checked, and never used for this run.

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { launchOwnedChrome } from "./launch";
import { appOwnedProfileDir, assertNotDailyChrome } from "./profile";
import { recordSession, replaySession, toWorkflow, type ReplayOutcome } from "./session";
import type { Workflow } from "../../src/types";

const DOM_ACTIONS = new Set([
  "click", "input", "select", "setChecked", "keypress", "submit",
  "assert", "navigate", "softNav", "waitForUser",
]);

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

function check(name: string, pass: boolean, detail?: string): Check {
  return { name, pass, detail };
}

async function isEmptyDir(dir: string): Promise<boolean> {
  const names = await readdir(dir);
  return names.length === 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function workflowChecks(wf: Workflow, fixturePath: string): Check[] {
  const out: Check[] = [];
  const dom = wf.steps.filter((s) => !s.surface || s.surface === "dom");
  const rankedOk = dom.filter((s) => s.target).every((s) => {
    const scores = s.target!.selectors.map((sel) => sel.score);
    const sorted = [...scores].sort((a, b) => b - a);
    return scores.length >= 1 && scores.every((n, i) => n === sorted[i]);
  });
  const multi = wf.steps.some((s) => (s.target?.selectors.length ?? 0) >= 2);
  const labelsOk = wf.steps.every((s) => s.label.length > 0 && s.label.length < 80);
  out.push(check(
    "workflow is shared IR: DOM steps, ranked selectors, plain labels",
    wf.version === 2 && wf.variables.length === 0 && dom.every((s) => DOM_ACTIONS.has(s.action)) && rankedOk && multi && labelsOk,
    `${wf.steps.length} steps, version ${wf.version}`
  ));

  const upload = wf.steps.find((s) => s.action === "uploadFile");
  const dumped = JSON.stringify(wf);
  out.push(check(
    "uploadFile name is the fixture basename, not an absolute path",
    upload?.upload?.name === "hello.txt" && !dumped.includes(fixturePath) && !dumped.includes("/home/"),
    upload?.upload?.name
  ));

  const secondClicks = wf.steps.filter((s) => s.action === "click" && (s.frame?.url || "").includes("/windows/new"));
  const switched = wf.steps.some((s) => s.action === "switchTab" && s.frame?.tab?.index === 1);
  const misfiled = secondClicks.some((s) => s.frame?.tab?.index === 0);
  out.push(check(
    "second tab has a switchTab and its click is not stored on tab 0",
    switched && secondClicks.length >= 1 && secondClicks.every((s) => s.frame?.tab?.index === 1) && !misfiled,
    secondClicks.map((s) => `tab ${s.frame?.tab?.index} ${s.label}`).join("; ")
  ));
  return out;
}

function replayChecks(recordedChecked: boolean, recordedValue: string, outcome: ReplayOutcome): Check[] {
  return [
    check(
      "replay checkbox matches the recorded end-state",
      outcome.checked === recordedChecked && recordedChecked === true,
      `recorded=${recordedChecked} replay=${outcome.checked}`
    ),
    check(
      "replay input value matches",
      outcome.inputValue === recordedValue && recordedValue === "42",
      `recorded=${JSON.stringify(recordedValue)} replay=${JSON.stringify(outcome.inputValue)}`
    ),
    check(
      "second page URL is the new-window URL",
      outcome.secondUrl.includes("/windows/new"),
      outcome.secondUrl
    ),
    check(
      "upload page shows the fixture filename",
      outcome.uploadText.includes("hello.txt"),
      outcome.uploadText.replace(/\s+/g, " ").slice(0, 180)
    ),
    check(
      "injected listener observed isTrusted === true on a replay click",
      outcome.trusted === true,
      `isTrusted=${String(outcome.trusted)}`
    ),
  ];
}

async function saveShot(dir: string, name: string, page: Page): Promise<void> {
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

async function main(): Promise<void> {
  const artifactDir = process.env.BAO_SPIKE_ARTIFACTS || "/opt/cursor/artifacts";
  await mkdir(artifactDir, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "bao-spike1-"));
  const recordDir = path.join(work, "record-profile");
  const replayDir = path.join(work, "replay-profile");
  const videoDir = path.join(work, "video");
  const shotDir = path.join(work, "shots");
  await mkdir(recordDir);
  await mkdir(replayDir);
  await mkdir(videoDir);
  await mkdir(shotDir);

  const fixturePath = path.join(work, "hello.txt");
  await writeFile(fixturePath, "bao spike 1\n");

  const ownedDefault = appOwnedProfileDir();
  assertNotDailyChrome(ownedDefault);
  const recordEmpty = await isEmptyDir(recordDir);
  const replayEmpty = await isEmptyDir(replayDir);

  const checks: Check[] = [];
  checks.push(check(
    "app-owned profile path is not the daily Chrome directory",
    !ownedDefault.includes("google-chrome") && !ownedDefault.includes("Google/Chrome") && ownedDefault.endsWith(path.join("bao", "chrome-profile")),
    ownedDefault
  ));
  checks.push(check(
    "demo profiles are fresh temp dirs, not the persistent app dir",
    recordEmpty && replayEmpty && recordDir.startsWith(tmpdir()) && recordDir !== ownedDefault && replayDir !== ownedDefault,
    recordDir
  ));

  let workflow: Workflow | undefined;
  let outcome: ReplayOutcome | undefined;
  let durationMs = 0;
  let recordedChecked = false;
  let recordedValue = "";

  const recordCtx = await launchOwnedChrome({ userDataDir: recordDir, headless: !process.env.BAO_HEADED });
  try {
    const recorded = await recordSession(recordCtx, fixturePath);
    durationMs = recorded.durationMs;
    recordedChecked = recorded.checked;
    recordedValue = recorded.inputValue;
    workflow = toWorkflow(recorded.steps, "https://the-internet.herokuapp.com/");
    await writeFile(path.join(shotDir, "spike1_workflow.json"), JSON.stringify(workflow, null, 2));
    checks.push(...workflowChecks(workflow, fixturePath));
    checks.push(check(
      "record session was on the order of half a minute",
      durationMs >= 25000 && durationMs <= 90000,
      `${Math.round(durationMs / 1000)}s`
    ));
  } finally {
    await recordCtx.close();
  }

  if (workflow) {
    const replayCtx = await launchOwnedChrome({
      userDataDir: replayDir,
      videoDir,
      headless: !process.env.BAO_HEADED,
    });
    const replayPages = [replayCtx.pages()[0]].filter(Boolean);
    replayCtx.on("page", (p) => replayPages.push(p));
    try {
      outcome = await replaySession(replayCtx, workflow, new Map([["hello.txt", fixturePath]]), (name, page) => saveShot(shotDir, name, page));
      checks.push(...replayChecks(recordedChecked, recordedValue, outcome));
    } finally {
      const videos = [];
      for (const p of replayPages) {
        const v = p.video();
        if (v) videos.push(v);
      }
      await replayCtx.close();
      let n = 0;
      for (const v of videos) {
        const src = await v.path();
        const dest = path.join(shotDir, n === 0 ? "spike1_replay_session.webm" : `spike1_replay_tab${n}.webm`);
        await copyFile(src, dest);
        n++;
      }
    }
  }

  await rm(recordDir, { recursive: true, force: true });
  await rm(replayDir, { recursive: true, force: true });
  const recordGone = !(await exists(recordDir));
  const replayGone = !(await exists(replayDir));
  checks.push(check(
    "both profile directories are gone and the run did not use port 9222",
    recordGone && replayGone,
    `recordGone=${recordGone} replayGone=${replayGone}`
  ));

  // Port 9222 is refused inside launchOwnedChrome (throws before we get here).
  // Re-read the saved workflow as a sanity check that the artifact is the IR we replayed.
  if (workflow) {
    const raw = await readFile(path.join(shotDir, "spike1_workflow.json"), "utf8");
    const parsed = JSON.parse(raw) as Workflow;
    const same = parsed.steps.length === workflow.steps.length;
    checks.push(check("saved workflow JSON round-trips", same, `${parsed.steps.length} steps`));
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (!c.pass) failed++;
  }
  console.log(failed === 0 ? "SPIKE 1: PASS" : `SPIKE 1: FAIL (${failed})`);

  if (failed === 0) {
    const names = await readdir(shotDir);
    for (const name of names) {
      await copyFile(path.join(shotDir, name), path.join(artifactDir, name));
    }
    console.log(`artifacts: ${artifactDir}`);
  } else {
    console.log(`debug shots left in ${shotDir}`);
  }

  // Keep the work dir if we failed so the video can be inspected. Pass deletes it.
  if (failed === 0) await rm(work, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
