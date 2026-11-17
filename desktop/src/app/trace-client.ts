// Browser script for /trace?run=<id>: loads one run and its step records and draws the trace view.
import type { HarEntry } from "../engines/step-har";
import type { Phase, RunRecordIndex, StepRecordView } from "./step-record-view";
import { axOutline, openPhase, requestDetail, shotAt, stepAt, stepTitle, TRACE_TABS, traceShell, traceSnapshot, traceSpan, traceTabs, type Source, type TraceRecord, type TraceRun, type TraceTab } from "./trace-view";
import { receiptClock } from "./views";

const runId = new URLSearchParams(location.search).get("run") || "";
const api = `/api/runs/${encodeURIComponent(runId)}`;
const root = document.getElementById("trace")!;
const records = new Map<string, Promise<TraceRecord>>();
let run: TraceRun;
let picked = -1;
let shown: TraceRecord;
let phase: Phase = "after";
let source: Source = "picture";
let tab: TraceTab = "call";

function $<T extends HTMLElement>(selector: string): T | null {
  return root.querySelector<T>(selector);
}

function once(target: EventTarget, name: string, limit = 2000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); target.removeEventListener(name, done); resolve(); };
    const timer = setTimeout(done, limit);
    target.addEventListener(name, done);
  });
}

function record(stepId: string): Promise<TraceRecord> {
  let found = records.get(stepId);
  if (!found) {
    found = fetch(`${api}/steps/${encodeURIComponent(stepId)}/record`).then((response) => {
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`step record request failed: ${response.status}`);
      return response.json() as Promise<StepRecordView>;
    });
    records.set(stepId, found);
  }
  return found;
}

function drawSnapshot(): void {
  const step = run.steps?.[picked];
  if (!step) return;
  $("#snapshot")!.innerHTML = traceSnapshot(run, step, shown, phase, source);
  stageSize.disconnect();
  stageSize.observe($(".stage")!);
}

const stageSize = new ResizeObserver(fitArchive);

/** The archive lays out at the width the page had when Bao read it, then scales down to the pane, or sits centred in a wider one. */
function fitArchive(): void {
  const frame = $<HTMLIFrameElement>("iframe.archive");
  if (!frame) return;
  const stage = frame.parentElement!;
  const width = Number(frame.dataset.width);
  const scale = Math.min(1, stage.clientWidth / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${stage.clientHeight / scale}px`;
  frame.style.left = `${(stage.clientWidth - width * scale) / 2}px`;
  frame.style.transform = `scale(${scale})`;
}

async function pick(index: number): Promise<void> {
  const step = run.steps?.[index];
  if (!step) return;
  picked = index;
  for (const el of root.querySelectorAll<HTMLElement>("[data-step]")) {
    const current = Number(el.dataset.step) === index;
    el.setAttribute("aria-current", String(current));
    if (current && el.classList.contains("action")) el.scrollIntoView({ block: "nearest" });
  }
  history.replaceState(null, "", `?run=${encodeURIComponent(runId)}&step=${index + 1}`);
  let stored: TraceRecord;
  try {
    stored = await record(step.id);
  } catch {
    records.delete(step.id);
    if (picked === index) {
      $("#snapshot")!.innerHTML = "";
      $("#tabs")!.innerHTML = `<p class="empty">Bao could not load this step's record. Pick the step again to retry.</p>`;
    }
    return;
  }
  if (picked !== index) return;
  shown = stored;
  phase = openPhase(run, step, stored);
  drawSnapshot();
  $("#tabs")!.innerHTML = traceTabs(run, step, stored, tab);
}

async function toggleRequest(line: HTMLElement): Promise<void> {
  const step = run.steps?.[picked];
  const open = line.nextElementSibling;
  if (open?.classList.contains("request-row")) return open.remove();
  if (!step) return;
  const detail = document.createElement("tr");
  detail.className = "request-row";
  detail.innerHTML = `<td colspan="7"><p class="empty">Loading…</p></td>`;
  line.after(detail);
  const response = await fetch(`${api}/steps/${encodeURIComponent(step.id)}/request-${line.dataset.request}.json`).catch(() => undefined);
  detail.firstElementChild!.innerHTML = response?.ok ? requestDetail(await response.json() as HarEntry) : `<p class="empty">Bao could not load this request. Close and open the row to retry.</p>`;
}

async function loadTree(details: HTMLDetailsElement): Promise<void> {
  const pre = details.querySelector("pre")!;
  if (!details.open || details.dataset.loaded) return;
  const response = await fetch(details.dataset.ax!).catch(() => undefined);
  if (!response?.ok) { pre.textContent = "Bao could not load the accessibility tree. Close and open this section to retry."; return; }
  details.dataset.loaded = "true";
  pre.textContent = axOutline(await response.json()) || "The tree holds no named nodes.";
}

function timelineTime(timeline: HTMLElement, clientX: number): number {
  const box = timeline.getBoundingClientRect();
  const origin = Number(timeline.dataset.origin);
  return origin + Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * (Number(timeline.dataset.end) - origin);
}

function hover(timeline: HTMLElement, event: MouseEvent): void {
  const time = timelineTime(timeline, event.clientX);
  const left = event.clientX - timeline.getBoundingClientRect().left;
  const cursor = $("#timeline .cursor")!;
  const preview = $("#timeline .preview")!;
  cursor.hidden = preview.hidden = false;
  cursor.style.left = `${left}px`;
  preview.style.left = `${Math.min(Math.max(left, 130), timeline.clientWidth - 130)}px`;
  const step = run.steps?.[stepAt(run, time)];
  preview.querySelector(".time")!.textContent = receiptClock(time - Number(timeline.dataset.origin));
  preview.querySelector(".name")!.textContent = step ? stepTitle(step) : "";
  const video = preview.querySelector("video");
  if (video) {
    if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, Math.max(0, (time - Number(timeline.dataset.videoOrigin)) / 1000));
    return;
  }
  const picture = preview.querySelector("img")!;
  const src = shotAt(run, time);
  picture.hidden = !src;
  if (src && picture.getAttribute("src") !== src) picture.src = src;
}

/** Thumbnails along the timeline: frames of the run's video, or with no video the newest picture a step kept by each time. */
async function film(): Promise<void> {
  const strip = $("#timeline .film")!;
  const { origin, end } = traceSpan(run);
  const count = Math.max(1, Math.floor(strip.clientWidth / 96));
  const times = Array.from({ length: count }, (_, index) => origin + ((index + 0.5) / count) * (end - origin));
  if (!run.video) {
    strip.innerHTML = times.map((time) => { const src = shotAt(run, time); return src ? `<img alt="" src="${src}">` : `<span></span>`; }).join("");
    return;
  }
  strip.innerHTML = times.map(() => `<canvas></canvas>`).join("");
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = `${api}/video`;
  await once(video, "loadeddata", 10_000);
  if (!video.videoWidth) return;
  const videoOrigin = Number($("#timeline")!.dataset.videoOrigin);
  for (const [index, canvas] of [...strip.querySelectorAll("canvas")].entries()) {
    video.currentTime = Math.min(video.duration, Math.max(0, (times[index]! - videoOrigin) / 1000));
    await once(video, "seeked");
    canvas.width = 192;
    canvas.height = Math.round(192 * video.videoHeight / video.videoWidth);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
}

function wire(): void {
  root.addEventListener("click", (event) => {
    const at = (event.target as HTMLElement).closest<HTMLElement>("[data-step], [data-phase], [data-source], [data-tab], [data-side], tr[data-request], #timeline");
    if (!at) return;
    if (at.dataset.step) void pick(Number(at.dataset.step));
    else if (at.dataset.phase) { phase = at.dataset.phase as Phase; drawSnapshot(); }
    else if (at.dataset.source) { source = at.dataset.source as Source; drawSnapshot(); }
    else if (at.dataset.tab) {
      tab = at.dataset.tab as TraceTab;
      for (const name of TRACE_TABS) {
        $(`#tabs [data-tab="${name}"]`)?.setAttribute("aria-selected", String(name === tab));
        $(`#tabs [data-panel="${name}"]`)!.hidden = name !== tab;
      }
    } else if (at.dataset.side) {
      for (const name of ["actions", "metadata"]) {
        $(`[data-side="${name}"]`)!.setAttribute("aria-selected", String(name === at.dataset.side));
        $(`#${name}`)!.hidden = name !== at.dataset.side;
      }
    } else if (at.dataset.request) void toggleRequest(at);
    else void pick(stepAt(run, timelineTime(at, event.clientX)));
  });
  root.addEventListener("input", (event) => {
    const filter = event.target as HTMLInputElement;
    if (!filter.matches(".net-filter")) return;
    const wanted = filter.value.trim().toLowerCase();
    for (const line of root.querySelectorAll<HTMLElement>("tr[data-request]")) {
      line.hidden = !line.textContent!.toLowerCase().includes(wanted);
      if (line.hidden && line.nextElementSibling?.classList.contains("request-row")) line.nextElementSibling.remove();
    }
  });
  root.addEventListener("toggle", (event) => {
    const details = event.target as HTMLElement;
    if (details instanceof HTMLDetailsElement && details.dataset.ax) void loadTree(details);
  }, true);
  document.addEventListener("keydown", (event) => {
    const on = event.target as HTMLElement;
    if (event.key === "Enter" && on.matches("tr[data-request]")) void toggleRequest(on);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (on.closest(".panel, input, textarea, select")) return;
    event.preventDefault();
    void pick(picked + (event.key === "ArrowDown" ? 1 : -1));
  });
  const timeline = $("#timeline")!;
  timeline.addEventListener("mousemove", (event) => hover(timeline, event));
  timeline.addEventListener("mouseleave", () => { $("#timeline .cursor")!.hidden = $("#timeline .preview")!.hidden = true; });
}

async function start(): Promise<void> {
  try {
    if (localStorage.getItem("bao-theme") === "dark") document.documentElement.dataset.theme = "dark";
  } catch { /* private mode */ }
  let index: RunRecordIndex;
  try {
    const [runResponse, indexResponse] = await Promise.all([fetch(api), fetch(`${api}/record`)]);
    if (!runId || !runResponse.ok) throw new Error("run unavailable");
    run = await runResponse.json() as TraceRun;
    index = indexResponse.ok ? await indexResponse.json() as RunRecordIndex : { steps: [] };
  } catch {
    root.innerHTML = `<p class="empty">Bao could not load this run. <a href="">Try again</a>, or go back to <a href="/">Runs</a>.</p>`;
    return;
  }
  root.innerHTML = traceShell(run, index);
  document.title = `Trace: ${$("h1")!.textContent}`;
  wire();
  const asked = Number(new URLSearchParams(location.search).get("step"));
  const failed = (run.steps || []).findIndex((step) => step.status === "failed");
  void pick(asked >= 1 ? asked - 1 : Math.max(failed, 0));
  void film();
}

void start();
