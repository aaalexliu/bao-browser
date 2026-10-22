// Replay the saved proof workflows and write a find miss for each give-up.
// BAO_FIND_DEBUG is the output directory. One task id per argv.

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchOwnedChrome } from "../launch";
import { BrowserDriver } from "../v1/browser-driver";
import { replay } from "../v1/replay";
import type { WorkflowV2 } from "../v1/schema";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error("task id");
  const root = path.join(process.cwd(), "docs/proof/realworld");
  const workflow = JSON.parse(readFileSync(path.join(root, "workflows", `${id}.json`), "utf8")) as WorkflowV2;
  const args: Record<string, string> = {};
  for (const input of workflow.inputs) if (input.default) args[input.name] = input.default;

  const profile = await mkdtemp(path.join(tmpdir(), "bao-find-"));
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  const page = context.pages()[0] || await context.newPage();
  const driver = new BrowserDriver(page);
  const result = await replay(workflow, args, driver, {
    heal: { available: () => false, propose: async () => null },
  });
  console.log(JSON.stringify({
    id,
    status: result.status,
    url: page.url(),
    failure: result.failure ? { stepId: result.failure.stepId, phase: result.failure.phase, reason: result.failure.reason } : undefined,
    steps: result.steps.map((step) => ({ id: step.id, status: step.status, reason: step.reason })),
  }));
  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
