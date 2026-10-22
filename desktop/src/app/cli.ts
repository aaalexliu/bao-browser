// bao serve | bao mcp | bao import-login --from chrome --domain experian.com

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { startApp } from "./server";
import { mcpMain } from "../mcp/server";
import { mcpBaoMain } from "../proxy/mcp-bao";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "mcp") {
    if (process.platform === "darwin") await mcpBaoMain();
    else await mcpMain();
    return;
  }
  if (cmd === "import-login") {
    await importLogin(rest);
    return;
  }
  if (cmd === "serve" || !cmd) {
    const home = flag(rest, "--home") || process.env.BAO_HOME || defaultHome();
    const port = Number(flag(rest, "--port") || process.env.BAO_PORT || 4787);
    const app = await startApp({ home, port });
    console.log(`bao ${app.port} home ${home}`);
    await new Promise(() => {});
    return;
  }
  if (cmd === "replay") {
    console.log("use the app replay screen, or POST /api/replay");
    return;
  }
  console.error("usage: bao serve [--home dir] [--port n] | bao mcp | bao import-login --from chrome --domain <host> [--profile <name>]");
  process.exit(1);
}

async function importLogin(args: string[]): Promise<void> {
  const from = flag(args, "--from");
  const domain = flag(args, "--domain");
  const profile = flag(args, "--profile");
  if (from !== "chrome" || !domain) {
    console.error("usage: bao import-login --from chrome --domain <host> [--profile <name>]");
    process.exit(1);
  }
  const port = Number(flag(args, "--port") || process.env.BAO_PORT || readServerPort(flag(args, "--home")) || 4787);
  const base = `http://127.0.0.1:${port}`;
  let created: { id?: string; message?: string; phase?: string; error?: string };
  try {
    const res = await fetch(`${base}/api/import-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, domain, profile }),
    });
    created = await res.json() as typeof created;
    if (!res.ok || !created.id) throw new Error(created.error || "start Bao first");
  } catch {
    console.error("start Bao first, then run import-login");
    process.exit(1);
  }
  console.log(created.message || "confirm in the Bao window");
  const deadline = Date.now() + 10 * 60 * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/import-login?id=${encodeURIComponent(created.id || "")}`);
    const body = await res.json() as { phase?: string; error?: string; audit?: { domain?: string; count?: number } };
    const line = body.phase === "pick"
      ? "pick a Chrome profile in the Bao window"
      : body.phase === "running"
        ? "waiting for the keychain prompt"
        : body.phase === "confirm"
          ? "confirm in the Bao window"
          : "";
    if (line && line !== last) {
      console.log(line);
      last = line;
    }
    if (body.phase === "done") {
      console.log(`imported ${body.audit?.count ?? 0} cookies for ${body.audit?.domain || domain}`);
      return;
    }
    if (body.phase === "cancelled") {
      console.error("import cancelled");
      process.exit(1);
    }
    if (body.phase === "error") {
      console.error(body.error || "import failed");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("timed out waiting for confirm");
  process.exit(1);
}

function readServerPort(homeFlag: string | undefined): number | undefined {
  const homes = [
    homeFlag,
    process.env.BAO_HOME,
    process.platform === "darwin" ? path.join(homedir(), "Library", "Application Support", "bao") : undefined,
    path.join(homedir(), ".local", "share", "bao"),
  ].filter((home): home is string => !!home);
  for (const home of homes) {
    const file = path.join(home, "server.json");
    if (!existsSync(file)) continue;
    try {
      const port = Number((JSON.parse(readFileSync(file, "utf8")) as { port?: number }).port);
      if (port > 0) return port;
    } catch {
      continue;
    }
  }
  return undefined;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function defaultHome(): string {
  const { homedir } = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return path.join(homedir(), ".local", "share", "bao");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
