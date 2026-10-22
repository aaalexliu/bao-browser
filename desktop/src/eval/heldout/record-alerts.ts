// A new alerts trail from the page recorder. The frozen batch 2 trail is not touched.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrailEvent } from "../../v1/interpret";
import { recorderSource } from "../../v1/recorder";
import { launchOwnedChrome } from "../../launch";
import type { HeldTruth } from "./capture";

const START = "https://the-internet.herokuapp.com/javascript_alerts";

export async function recordAlertsTrail(dir: string): Promise<HeldTruth> {
  mkdirSync(dir, { recursive: true });
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
    await page.locator("h3").click();
    await page.locator("text=Click for JS Alert").click();
    await page.waitForTimeout(150);
  } finally {
    await context.close().catch(() => undefined);
  }
  const keep = events.filter((event) => event.dialogType === "alert").map((event) => event.id);
  const alert = events.find((event) => event.dialogType === "alert");
  if (keep.length !== 1 || !alert?.dialog || alert.dialogDecision !== "accept") {
    throw new Error(`alerts recording did not store the dialog (${keep.join(",") || "none"})`);
  }
  if (!alert.subtreeAfter?.includes("successfully clicked an alert")) {
    throw new Error("alerts recording missed the result text");
  }
  const truth: HeldTruth = {
    id: "alerts-dialog",
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
  writeFileSync(path.join(dir, "alerts-dialog.json"), JSON.stringify(events, null, 2));
  writeFileSync(path.join(dir, "truth.json"), JSON.stringify([truth], null, 2));
  console.log(`alerts-dialog events ${events.length} keep ${keep.join(",")} dialog ${alert.dialogType} ${alert.dialogDecision}`);
  return truth;
}
