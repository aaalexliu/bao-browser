// Dialog trails from the page recorder.
// recordAlertsTrail writes a standalone dir and leaves batch 2 alone.
// recordAlertsV2 replaces the scored batch 2 alerts trail. The previous
// trail stays at docs/eval/heldout/batch2/history/alerts.v1.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrailEvent } from "../../v1/interpret";
import { recorderSource } from "../../v1/recorder";
import { launchOwnedChrome } from "../../launch";
import type { HeldTruth } from "./capture";

const START = "https://the-internet.herokuapp.com/javascript_alerts";

export const ALERTS_V2_REASON = "v1 (history/alerts.v1.json) stored the alert click with matching urls and no dialog, subtree, or result text, so the effect filter dropped it and replay never clicked the button. v2 records the same clicks with the dialog recorder, which stores the dialog and the result text.";

export async function recordAlertsTrail(dir: string): Promise<HeldTruth> {
  mkdirSync(dir, { recursive: true });
  const events = await recordClicks(["h3", "text=Click for JS Alert"]);
  const truth = alertsTruth("alerts-dialog", events);
  writeFileSync(path.join(dir, "alerts-dialog.json"), JSON.stringify(events, null, 2));
  writeFileSync(path.join(dir, "truth.json"), JSON.stringify([truth], null, 2));
  const alert = events.find((event) => event.dialogType === "alert");
  console.log(`alerts-dialog events ${events.length} keep ${truth.keep.join(",")} dialog ${alert?.dialogType} ${alert?.dialogDecision}`);
  return truth;
}

/** Re-record the frozen alerts clicks and point batch 2 truth at alerts.v2. */
export async function recordAlertsV2(batchDir: string): Promise<HeldTruth> {
  const events = await recordClicks([
    "h3",
    "h3",
    "text=Click for JS Confirm",
    "text=Click for JS Alert",
  ]);
  const truth = alertsTruth("alerts", events);
  truth.version = 2;
  truth.trail = "alerts.v2";
  truth.reason = ALERTS_V2_REASON;
  writeFileSync(path.join(batchDir, "alerts.v2.json"), JSON.stringify(events, null, 2));
  const truths = JSON.parse(readFileSync(path.join(batchDir, "truth.json"), "utf8")) as HeldTruth[];
  const index = truths.findIndex((item) => item.id === "alerts");
  if (index < 0) throw new Error(`no alerts case in ${batchDir}`);
  truths[index] = { ...truths[index], ...truth };
  writeFileSync(path.join(batchDir, "truth.json"), JSON.stringify(truths, null, 2));
  console.log(`alerts v2 events ${events.length} keep ${truth.keep.join(",")}`);
  return truth;
}

function alertsTruth(id: string, events: TrailEvent[]): HeldTruth {
  const keep = events.filter((event) => event.dialogType === "alert").map((event) => event.id);
  const alert = events.find((event) => event.dialogType === "alert");
  if (keep.length !== 1 || !alert?.dialog || alert.dialogDecision !== "accept") {
    throw new Error(`alerts recording did not store the dialog (${keep.join(",") || "none"})`);
  }
  if (!alert.subtreeAfter?.includes("successfully clicked an alert")) {
    throw new Error("alerts recording missed the result text");
  }
  return {
    id,
    name: "Accept a JavaScript alert",
    startUrl: START,
    keep,
    secrets: [],
    secretIds: [],
    human: [],
    replays: [
      { texts: [], secret: "", file: "" },
      { texts: [], secret: "", file: "" },
    ],
    oracle: { kind: "body", includes: "successfully clicked an alert" },
  };
}

async function recordClicks(selectors: string[]): Promise<TrailEvent[]> {
  const profile = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join("/tmp", "bao-alerts-")));
  const events: TrailEvent[] = [];
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
      events.push({ ...payload, id: `e${events.length}`, ts: Date.now() });
    });
    await context.addInitScript(recorderSource());
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("dialog", (dialog) => {
      dialog.accept().catch(() => undefined);
    });
    await page.goto(START, { waitUntil: "domcontentloaded", timeout: 30000 });
    for (const selector of selectors) {
      await page.locator(selector).first().click();
      await page.waitForTimeout(150);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  return events;
}
