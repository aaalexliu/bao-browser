// One compressed record per agent_browser command, under the Library run folder.
// Later parts add sibling keys. A write keeps keys it does not own.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { assertDevtoolsHar, type DevtoolsHarEntry, type DevtoolsHarLog } from "../proxy/cdp-network";

export const STEP_RECORD_SCHEMA = "bao.step-record/v1";
const WHY_LIMIT = 500;

export interface StepWait {
  for: string;
  ms: number;
}

export interface StepRecord {
  schema: typeof STEP_RECORD_SCHEMA;
  id: string;
  command: string;
  args: string[];
  why?: string;
  status: "pending" | "passed" | "failed";
  error?: string;
  startedAt: number;
  endedAt?: number;
  waits: StepWait[];
  network: { entries: DevtoolsHarEntry[] };
}

const OWNED = ["schema", "id", "command", "args", "why", "status", "error", "startedAt", "endedAt", "waits", "network"] as const;

export function stepWhy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("why must be a short string");
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > WHY_LIMIT) throw new Error(`why must be at most ${WHY_LIMIT} characters`);
  return text;
}

export function stepRecordDir(home: string, runId: string): string {
  return path.join(home, "runs", runId);
}

export class StepRecordStore {
  private readonly dir: string;

  constructor(home: string, runId: string) {
    this.dir = stepRecordDir(home, runId);
  }

  async putBody(bytes: Buffer): Promise<string> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(this.dir, "bodies", sha);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return sha;
  }

  async readBody(sha: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path.join(this.dir, "bodies", sha));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Writes the step, keeping any sibling keys a later part already stored. */
  async writeStep(record: StepRecord): Promise<void> {
    const file = path.join(this.dir, "steps", `${record.id}.json.gz`);
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await readGzip(file);
    const next: Record<string, unknown> = { ...existing };
    for (const key of OWNED) delete next[key];
    const owned: Record<string, unknown> = { ...record };
    if (!record.why) delete owned.why;
    if (!record.error) delete owned.error;
    await writeAtomic(file, gzipSync(Buffer.from(JSON.stringify({ ...next, ...owned, schema: STEP_RECORD_SCHEMA }))));
  }

  async readStep(stepId: string): Promise<Record<string, unknown> | undefined> {
    return readGzip(path.join(this.dir, "steps", `${stepId}.json.gz`));
  }

  /** Replaces network entries on a sealed step. Other keys stay as they were. */
  async updateEntries(stepId: string, entries: readonly DevtoolsHarEntry[]): Promise<void> {
    const file = path.join(this.dir, "steps", `${stepId}.json.gz`);
    const existing = await readGzip(file);
    if (!existing) return;
    const network = existing.network && typeof existing.network === "object" ? existing.network as Record<string, unknown> : {};
    await writeAtomic(file, gzipSync(Buffer.from(JSON.stringify({ ...existing, network: { ...network, entries } }))));
  }

  async writeHar(entries: readonly DevtoolsHarEntry[]): Promise<void> {
    const inlined = await Promise.all(entries.map((entry) => this.withBody(entry)));
    const har: DevtoolsHarLog = {
      log: { version: "1.2", creator: { name: "bao", version: "1" }, entries: inlined },
    };
    assertDevtoolsHar(har);
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(path.join(this.dir, "run.har"), Buffer.from(JSON.stringify(har, null, 2)));
  }

  private async withBody(entry: DevtoolsHarEntry): Promise<DevtoolsHarEntry> {
    const next = structuredClone(entry);
    const response = entry._responseBody ? await this.readBody(entry._responseBody) : undefined;
    if (response) {
      const text = response.toString("utf8");
      next.response.content = Buffer.from(text).equals(response)
        ? { ...next.response.content, size: response.length, text }
        : { ...next.response.content, size: response.length, text: response.toString("base64"), encoding: "base64" };
    }
    const request = next._requestBody ? await this.readBody(next._requestBody) : undefined;
    if (request && next.request.postData) {
      const text = request.toString("utf8");
      next.request.postData = Buffer.from(text).equals(request)
        ? { ...next.request.postData, text }
        : { ...next.request.postData, text: request.toString("base64") };
    }
    return next;
  }
}

async function readGzip(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}
