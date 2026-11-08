// bao doctor: checks one installed Bao.app the way an agent would use it. It reads signatures,
// configs and files, and starts bao-mcp once for an MCP handshake. It asks for no macOS permission.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { appVersion, mcpLauncher } from "./bundle";
import { baoCommand, defaultProbe, detectTargets, parseSetup, type Probe } from "./setup";

type Level = "ok" | "warn" | "fail";

interface Check {
  level: Level;
  name: string;
  detail: string;
}

export interface DoctorIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

/** How a bundle is signed, from codesign -dvv: ad-hoc, or by the first Authority line and its team. */
export function signer(details: string): string {
  if (/Signature=adhoc/.test(details)) return "signed ad-hoc, with no certificate";
  const authority = /^Authority=(.+)$/m.exec(details)?.[1];
  const team = /^TeamIdentifier=(.+)$/m.exec(details)?.[1];
  if (!authority) return "unsigned";
  if (authority.startsWith("Developer ID Application")) return `signed by ${authority} (team ${team})`;
  return `signed by ${authority} (self-signed, not notarized)`;
}

function signatureCheck(name: string, bundle: string): Check {
  const verify = run("/usr/bin/codesign", ["--verify", "--strict", bundle]);
  const who = signer(run("/usr/bin/codesign", ["-dvv", bundle]).stderr);
  if (verify.status !== 0) return { level: "fail", name, detail: `codesign --verify failed: ${verify.stderr.trim().split("\n")[0]}` };
  return { level: "ok", name, detail: who };
}

/** One MCP exchange through the launcher an agent starts: initialize, then tools/list. */
export function mcpHandshake(launcher: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ tools: number; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no tools/list answer in ${timeoutMs} ms. ${stderr.trim().split("\n").at(-1) || ""}`));
    }, timeoutMs);
    const finish = (error: Error | null, tools = 0): void => {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve({ tools, ms: Date.now() - started });
    };
    child.on("error", (err) => finish(err));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        } else if (msg.id === 2) {
          if (msg.error) finish(new Error(msg.error.message || "tools/list failed"));
          else finish(null, msg.result?.tools?.length || 0);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bao-doctor", version: "1" } } })}\n`);
  });
}

export async function doctorChecks(app: string, probe: Probe): Promise<Check[]> {
  const checks: Check[] = [];
  const launcher = mcpLauncher(app);
  try {
    accessSync(launcher, constants.X_OK);
    checks.push({ level: "ok", name: "Bao.app", detail: `${app} (${appVersion(app) ?? "unknown version"})` });
  } catch {
    checks.push({ level: "fail", name: "Bao.app", detail: `${launcher} is missing. Install Bao again.` });
    return checks;
  }
  checks.push(signatureCheck("signature", app));
  const quarantine = run("/usr/bin/xattr", ["-p", "com.apple.quarantine", app]);
  checks.push(quarantine.status === 0
    ? { level: "warn", name: "quarantine", detail: "a browser download marked this copy; macOS checks it the first time it opens" }
    : { level: "ok", name: "quarantine", detail: "not marked, so Gatekeeper does not stop the first open" });
  const bundled = path.join(app, "Contents", "Resources", "node", "bin", "node");
  checks.push(existsSync(bundled)
    ? { level: "ok", name: "node", detail: `bundled ${run(bundled, ["--version"]).stdout.trim()} at ${bundled}` }
    : { level: "warn", name: "node", detail: `not bundled; this copy uses Node from the Mac (${process.execPath} ${process.version})` });
  const helper = path.join(app, "Contents", "Resources", "BaoOSHelper.app");
  if (existsSync(helper)) {
    const check = signatureCheck("helper", helper);
    checks.push({ ...check, detail: `${check.detail}. Optional: only running-Chrome mode uses it, with an Accessibility grant` });
  } else {
    checks.push({ level: "ok", name: "helper", detail: "not installed. The default copied-profile mode does not need it" });
  }
  const chrome = ["/Applications/Google Chrome.app", path.join(probe.home, "Applications", "Google Chrome.app")].find((dir) => existsSync(dir));
  checks.push(chrome
    ? { level: "ok", name: "chrome", detail: chrome }
    : { level: "warn", name: "chrome", detail: "Google Chrome is not installed. agent_browser copies a Chrome profile by default" });
  const bao = baoCommand(probe, app);
  for (const target of detectTargets(probe)) {
    if (target.command === launcher) checks.push({ level: "ok", name: target.id, detail: `${target.file} starts this Bao` });
    else if (target.command || target.found) {
      const state = target.command ? `${target.file} starts ${target.command}` : `found (${target.found}) but not set up`;
      const next = target.blocked ? `${target.label} ${target.blocked}` : `Run ${bao} setup --agents ${target.id}`;
      checks.push({ level: "warn", name: target.id, detail: `${state}. ${next}` });
    }
  }
  try {
    const env = { ...probe.env };
    for (const key of Object.keys(env)) if (key.startsWith("BAO_")) delete env[key];
    const answer = await mcpHandshake(launcher, env);
    checks.push({ level: "ok", name: "mcp", detail: `bao-mcp listed ${answer.tools} tools in ${answer.ms} ms` });
  } catch (err) {
    checks.push({ level: "fail", name: "mcp", detail: (err as Error).message });
  }
  return checks;
}

export async function doctorMain(argv: readonly string[], io: DoctorIo = { env: process.env, out: (text) => process.stdout.write(text) }): Promise<number> {
  let app: string;
  try {
    app = parseSetup(argv).app;
  } catch (err) {
    io.out(`${(err as Error).message}\nusage: bao doctor [--app /Applications/Bao.app]\n`);
    return 1;
  }
  const checks = await doctorChecks(app, defaultProbe(io.env));
  for (const check of checks) io.out(`${check.level.padEnd(4)} ${check.name.padEnd(14)} ${check.detail}\n`);
  return checks.some((check) => check.level === "fail") ? 1 : 0;
}
