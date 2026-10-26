import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutputTable } from "../v1/data-steps";
import { unavailableHeal } from "../v1/heal";
import { replay, type RunResult } from "../v1/replay";
import { validateWorkflow, type WorkflowV2 } from "../v1/schema";
import { ALLOW_CLICK_WINDOW_MS, mayClickAllow, type AxSummary } from "./consent";
import { readDevToolsActivePort } from "./endpoint";
import { AxUnavailable, chromeHelper, chromeTree, ensureRemoteDebugging, pressAllow } from "./ax";
import { CdpLiveDriver, openLiveWindow, type PageObservation } from "./driver";
import { connectCdp, type CdpSocket } from "./socket";

function repoRoot(): string {
  const candidates = [process.cwd(), path.resolve(__dirname, "../../../../..")];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "docs/proof/realworld/workflows/p5.json"))) return dir;
  }
  throw new Error("p5 workflow not found");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progress(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

interface RunReport {
  index: number;
  status: RunResult["status"];
  pausedKind?: RunResult["pausedKind"];
  needsHuman: boolean;
  rows: number;
  ms: number;
  steps: { id: string; status: string; reason?: string; ms?: number }[];
  trust: PageObservation["trust"];
  trusted: boolean | null;
  webdriver: boolean | null;
  host: string;
  subframes: number;
  modelCalls: number;
}

function bookRows(result: RunResult): number {
  const table = result.outputs?.find((item): item is OutputTable => item.type === "table" && item.name === "books");
  return table?.rows.length ?? 0;
}

function reportRun(index: number, result: RunResult, observed: PageObservation | undefined, ms: number, subframes: number): RunReport {
  const trust = observed?.trust || [];
  const trusted = trust.length ? trust.every((event) => event.isTrusted) : null;
  return {
    index,
    status: result.status,
    pausedKind: result.pausedKind,
    needsHuman: result.status === "paused" && (result.pausedKind === "wall" || result.pausedKind === "signin"),
    rows: bookRows(result),
    ms,
    steps: result.steps.map((step) => ({
      id: step.id,
      status: step.status,
      reason: step.reason,
      ms: step.startedAt != null && step.endedAt != null ? step.endedAt - step.startedAt : undefined,
    })),
    trust,
    trusted,
    webdriver: observed ? observed.webdriver : null,
    host: observed?.host || "",
    subframes,
    modelCalls: result.modelCalls,
  };
}

async function oneRun(cdp: CdpSocket, workflow: WorkflowV2, index: number): Promise<{ report: RunReport; targetId: string }> {
  progress(`replay ${index} opening a new window`);
  const driver = await openLiveWindow(cdp);
  const started = Date.now();
  let result: RunResult | undefined;
  let observed: PageObservation | undefined;
  try {
    result = await replay(workflow, { category: "Mystery" }, driver, {
      runId: `cdp-live-p5-${index}`,
      now: () => Date.now(),
      heal: unavailableHeal(),
      siteTrust: "allow",
      holdForPerson: false,
    });
    observed = await driver.observe().catch(() => undefined);
  } finally {
    await driver.end().catch(() => undefined);
  }
  if (!result) throw new Error("replay produced no result");
  progress(`replay ${index} ${result.status} rows ${bookRows(result)}`);
  return {
    targetId: driver.targetId,
    report: reportRun(index, result, observed, Date.now() - started, driver.subframesSeen.count),
  };
}

async function main(): Promise<void> {
  const root = repoRoot();
  const evidence = path.join(root, ".evidence");
  const axLog = path.join(evidence, "cdp-live-ax.jsonl");
  await mkdir(evidence, { recursive: true });
  const helper = chromeHelper();
  progress("helper permissions");
  const perms = await helper.permissions(false);
  if (perms.prompted) throw new Error("helper asked for a permission prompt");
  if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
  const permissions = {
    accessibility: perms.accessibility === true,
    screenCapture: perms.screenCapture === true,
    prompted: false,
    exe: path.basename(perms.exe || ""),
    parentExe: path.basename(perms.parentExe || ""),
  };
  progress(`accessibility ${permissions.accessibility} screenCapture ${permissions.screenCapture}`);
  progress("reading the remote-debugging checkbox");
  const enabled = await ensureRemoteDebugging(helper, axLog);
  const before = enabled.summary.dialog;
  const dialogPresentBeforeConnect = before.present || before.buttonCount > 0;
  if (dialogPresentBeforeConnect) {
    throw new AxUnavailable("Allow dialog was already up; not connecting and not clicking", enabled.summary);
  }
  progress("reading DevToolsActivePort");
  const endpoint = await readDevToolsActivePort();
  progress(`browser socket on port ${endpoint.port}`);
  const abort = new AbortController();
  const connectionStartedAt = Date.now();
  let opened = false;
  const pending = connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 200_000, signal: abort.signal })
    .then((socket) => {
      opened = true;
      return socket;
    });
  pending.catch(() => undefined);
  let last = enabled.summary;
  let clickedAt: number | undefined;
  let allowWindow = "";
  const deadline = connectionStartedAt + ALLOW_CLICK_WINDOW_MS;
  while (Date.now() < deadline && !opened) {
    progress("reading AX for the Allow dialog");
    const tree = await chromeTree(helper);
    last = tree.summary;
    if (opened) break;
    if (mayClickAllow({
      openedByBao: true,
      connectionStartedAt,
      now: Date.now(),
      dialogPresentBeforeConnect,
      dialog: tree.summary.dialog,
    })) {
      if (opened) break;
      progress("pressing Allow");
      const pressed = await pressAllow(helper, enabled.pid, axLog);
      clickedAt = pressed.at;
      allowWindow = pressed.window;
      break;
    }
  }
  if (clickedAt == null && !opened) {
    abort.abort();
    await pending.catch(() => undefined);
    throw new AxUnavailable("BaoOSHelper cannot see the Allow remote debugging dialog", last);
  }
  const cdp = await pending;
  const connectToAllowMs = clickedAt == null ? null : clickedAt - connectionStartedAt;
  progress(`socket open; connect-to-Allow ${connectToAllowMs == null ? "not clicked" : `${connectToAllowMs}ms`}`);
  const workflow = JSON.parse(await readFile(path.join(root, "docs/proof/realworld/workflows/p5.json"), "utf8")) as WorkflowV2;
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new Error(`p5 workflow ${errors.join(",")}`);
  const runs: RunReport[] = [];
  try {
    for (let index = 1; index <= 2; index++) {
      const { report } = await oneRun(cdp, workflow, index);
      runs.push(report);
      if (report.needsHuman) break;
    }
    progress("reading the automation banner");
    const during = (await chromeTree(helper)).summary.banner;
    await sleep(300);
    cdp.close();
    await sleep(500);
    progress("reading the banner after the socket closed");
    const after = (await chromeTree(helper)).summary.banner;
    const body = {
      permissions,
      checkbox: { value: enabled.summary.checkbox.value, pressed: enabled.pressed },
      port: endpoint.port,
      dialogPresentBeforeConnect,
      allowClicked: clickedAt != null,
      allowWindow,
      connectToAllowMs,
      banner: { during, afterClose: after },
      runs,
    };
    await writeFile(path.join(evidence, "cdp-live-run.json"), `${JSON.stringify(body, null, 2)}\n`);
    progress("wrote .evidence/cdp-live-run.json");
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } finally {
    cdp.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    const summary = err instanceof AxUnavailable ? err.summary : undefined;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (summary) process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exit(1);
  });
}
