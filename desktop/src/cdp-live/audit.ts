import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveBaoHome } from "../app/bao-home";
import { publicLiveSession, shotName, type LiveSessionRecord, type LiveStep } from "./live-record";

export {
  liveShotUrl,
  publicLiveSession,
  redactLabel,
  shotName,
  shotNameOk,
  type AuditRow,
  type LiveSessionRecord,
  type LiveStep,
} from "./live-record";

export function liveSessionDir(home = resolveBaoHome()): string {
  return path.join(home, "live-session");
}

export class SessionLog {
  private shots = 0;
  private record: LiveSessionRecord;

  constructor(private readonly dir: string, intent: string, id = "live") {
    this.record = {
      id,
      intent,
      status: "running",
      host: "",
      updatedAt: Date.now(),
      steps: [],
      audit: [],
      note: "",
    };
  }

  async add(row: {
    action: string;
    label: string;
    path: string;
    isTrusted: boolean | null;
    ms: number;
    via?: "ax" | "cdp";
    png?: Buffer;
  }): Promise<string> {
    let shot = "";
    if (row.png && row.png.length > 32) {
      this.shots += 1;
      shot = shotName(this.shots);
      const folder = path.join(this.dir, "shots");
      await mkdir(folder, { recursive: true });
      await writeAtomic(path.join(folder, shot), row.png);
    }
    const clean = publicLiveSession({
      ...this.record,
      audit: [...this.record.audit, {
        action: row.action,
        label: row.label,
        path: row.path,
        isTrusted: row.isTrusted,
        ms: row.ms,
        at: Date.now(),
        shot,
        via: row.via || "cdp",
      }],
    });
    if (clean) this.record = clean;
    await this.flush(this.record.status);
    return shot;
  }

  setSteps(steps: LiveStep[]): void {
    this.record.steps = steps;
  }

  async patchLast(isTrusted: boolean | null): Promise<void> {
    const last = this.record.audit[this.record.audit.length - 1];
    if (!last) return;
    last.isTrusted = isTrusted;
    await this.flush(this.record.status);
  }

  async flush(status: LiveSessionRecord["status"], note = "", host = ""): Promise<void> {
    this.record.status = status;
    if (note) this.record.note = note;
    if (host) this.record.host = host;
    this.record.updatedAt = Date.now();
    const clean = publicLiveSession(this.record);
    if (!clean) return;
    this.record = clean;
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(path.join(this.dir, "session.json"), `${JSON.stringify(this.record, null, 2)}\n`);
  }
}

export async function readLiveSession(dir: string): Promise<LiveSessionRecord | null> {
  try {
    const raw = await readFile(path.join(dir, "session.json"), "utf8");
    return publicLiveSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
