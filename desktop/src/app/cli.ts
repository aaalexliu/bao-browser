// bao serve | bao mcp | bao replay workflow.json --args args.json

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
  console.error("usage: bao serve [--home dir] [--port n] | bao mcp");
  process.exit(1);
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
