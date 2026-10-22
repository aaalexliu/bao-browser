// One replay in a throwaway profile. The daily Chrome profile is not used.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { launchOwnedChrome } from "../launch";
import { BrowserDriver } from "./browser-driver";
import { unavailableHeal } from "./heal";
import { replay } from "./replay";
import { migrate, type ReplayArgs } from "./schema";

export interface GateResult {
  ok: boolean;
  stepId?: string;
  stepLabel?: string;
  reason?: string;
}

export async function runThrowawayGate(document: unknown, samples: Record<string, string> = {}): Promise<GateResult> {
  const workflow = migrate(document);
  const first = workflow.steps[0];
  if (!/^https?:\/\//i.test(workflow.startUrl)) {
    return { ok: false, stepId: first?.id || "start", stepLabel: first?.label || "Open the public site", reason: "the workflow has no public site" };
  }
  const profile = await mkdtemp(path.join(tmpdir(), "bao-gate-"));
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    page.setDefaultTimeout(12_000);
    await page.goto(workflow.startUrl, { waitUntil: "domcontentloaded" });
    const args: ReplayArgs = { ...samples };
    for (const input of workflow.inputs) {
      if (args[input.name]) continue;
      if (input.type === "file") {
        const file = path.join(profile, `${input.name}.txt`);
        writeFileSync(file, "bao\n");
        args[input.name] = { name: `${input.name}.txt`, path: file };
      } else if (input.type === "choice" && input.choices?.[0]) {
        args[input.name] = input.choices[0];
      } else if (input.default && input.type !== "secret") {
        args[input.name] = input.default;
      }
    }
    const result = await replay(workflow, args, new BrowserDriver(page), {
      heal: unavailableHeal(),
      now: () => Date.now(),
    });
    if (result.status === "passed") return { ok: true };
    const failed = result.failure?.stepId || result.steps.find((step) => step.status === "failed")?.id || first?.id || "start";
    const label = workflow.steps.find((step) => step.id === failed)?.label || failed;
    return {
      ok: false,
      stepId: failed,
      stepLabel: label,
      reason: result.failure?.reason || result.steps.find((step) => step.id === failed)?.reason || result.status,
    };
  } catch (err) {
    return {
      ok: false,
      stepId: first?.id || "start",
      stepLabel: first?.label || "Open the public site",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { document?: unknown; samples?: Record<string, string> };
  const result = await runThrowawayGate(body.document, body.samples || {});
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      stepId: "start",
      stepLabel: "Open the public site",
      reason: err instanceof Error ? err.message : String(err),
    }));
    process.exitCode = 1;
  });
}
