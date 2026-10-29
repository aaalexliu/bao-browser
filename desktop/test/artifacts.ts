import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const printed = new Set<string>();

export function artifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = [env.BAO_ARTIFACTS_DIR, env.BAO_ARTIFACTS]
    .map((value) => value?.trim())
    .find((value) => value);
  if (chosen) return path.resolve(chosen);
  return path.resolve(process.cwd(), "out", "test-artifacts", runId(env));
}

export function testArtifacts(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (name.trim() === "" || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`artifact leaf is not a single path segment: ${JSON.stringify(name)}`);
  }
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
  const dir = path.join(artifactsRoot(env), safe);
  mkdirSync(dir, { recursive: true });
  if (!printed.has(dir)) {
    printed.add(dir);
    console.log(`artifacts ${dir}`);
  }
  return dir;
}

export async function tryWriteEvidence(write: () => void | Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
  }
}

function runId(env: NodeJS.ProcessEnv): string {
  if (!env.BAO_TEST_RUN_ID) {
    env.BAO_TEST_RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  }
  return env.BAO_TEST_RUN_ID;
}
