// Floating native capture bar. The AppKit process owns the panel, the global
// shortcuts, the notification, and the dock badge. This side only speaks JSON lines.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface BarEvent {
  event?: string;
  name?: string;
  text?: string;
}

export function findCaptureBar(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.BAO_CAPTURE_BAR_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    path.join(process.cwd(), "desktop/packaging/macos/dist/BaoCaptureBar.app/Contents/MacOS/BaoCaptureBar"),
    path.resolve(process.cwd(), "../BaoCaptureBar.app/Contents/MacOS/BaoCaptureBar"),
  ];
  return candidates.find((file) => existsSync(file));
}

export class CaptureBar {
  private child?: ChildProcess;
  private buf = "";
  onEvent: (event: BarEvent) => void = () => {};

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  open(bin: string): void {
    if (this.child) return;
    const child = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) {
          try { this.onEvent(JSON.parse(line) as BarEvent); } catch { /* ignore a partial line */ }
        }
        nl = this.buf.indexOf("\n");
      }
    });
    child.on("error", () => {
      if (this.child === child) this.child = undefined;
    });
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
    });
  }

  send(message: object): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
