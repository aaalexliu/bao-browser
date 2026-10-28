import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface AuditRow {
  action: string;
  label: string;
  path: string;
  isTrusted: boolean | null;
  ms: number;
  at: number;
  shot: string;
  via: "ax" | "cdp";
}

export interface LiveStep {
  name: string;
  status: string;
  ms: number;
}

export interface LiveSessionRecord {
  id: string;
  intent: string;
  status: "running" | "passed" | "needs_human" | "failed" | "idle";
  host: string;
  updatedAt: number;
  steps: LiveStep[];
  audit: AuditRow[];
  note: string;
}

export function liveSessionDir(home = process.env.BAO_HOME || path.join(homedir(), ".local", "share", "bao")): string {
  return path.join(home, "live-session");
}

export function shotName(index: number): string {
  return `shot-${String(index).padStart(3, "0")}.png`;
}

export function shotNameOk(name: string): boolean {
  return /^shot-\d{3}\.png$/.test(name);
}

export function liveShotUrl(name: string): string {
  return shotNameOk(name) ? `/api/live-session/shots/${name}` : "";
}

export function redactLabel(text: string): string {
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\$\d+(?:\.\d{2})?/g, "")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (/@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b|\bssn\b|\bpassword\b/i.test(clean)) return "";
  return clean.slice(0, 80);
}

export function publicLiveSession(value: unknown): LiveSessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LiveSessionRecord>;
  const status = raw.status;
  if (status !== "running" && status !== "passed" && status !== "needs_human" && status !== "failed" && status !== "idle") {
    return null;
  }
  const audit = Array.isArray(raw.audit) ? raw.audit.slice(0, 40).map((row) => ({
    action: redactLabel(String(row?.action || "")).slice(0, 40),
    label: redactLabel(String(row?.label || "")),
    path: String(row?.path || "").startsWith("/") ? String(row.path).slice(0, 120) : "",
    isTrusted: row?.isTrusted === true ? true : row?.isTrusted === false ? false : null,
    ms: Number.isFinite(row?.ms) ? Math.max(0, Math.round(Number(row.ms))) : 0,
    at: Number.isFinite(row?.at) ? Math.round(Number(row.at)) : 0,
    shot: shotNameOk(String(row?.shot || "")) ? String(row.shot) : "",
    via: row?.via === "ax" ? "ax" as const : "cdp" as const,
  })) : [];
  const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 40).map((step) => ({
    name: redactLabel(String(step?.name || "")).slice(0, 40),
    status: String(step?.status || "").slice(0, 20),
    ms: Number.isFinite(step?.ms) ? Math.max(0, Math.round(Number(step.ms))) : 0,
  })) : [];
  return {
    id: String(raw.id || "").replace(/[^\w.-]/g, "").slice(0, 40),
    intent: redactLabel(String(raw.intent || "")).slice(0, 160),
    status,
    host: /^[\w.-]+$/.test(String(raw.host || "")) ? String(raw.host) : "",
    updatedAt: Number.isFinite(raw.updatedAt) ? Math.round(Number(raw.updatedAt)) : 0,
    steps,
    audit,
    note: redactLabel(String(raw.note || "")).slice(0, 160),
  };
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
  }): Promise<void> {
    let shot = "";
    if (row.png && row.png.length > 32) {
      this.shots += 1;
      shot = shotName(this.shots);
      const folder = path.join(this.dir, "shots");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, shot), row.png);
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
  }

  setSteps(steps: LiveStep[]): void {
    this.record.steps = steps;
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
    await writeFile(path.join(this.dir, "session.json"), `${JSON.stringify(this.record, null, 2)}\n`);
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
