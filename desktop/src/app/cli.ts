// bao serve | bao mcp | bao sync | bao open bao://workflow/<id>

import { readFileSync } from "node:fs";
import { reviewWorkflow } from "../mcp/catalog";
import { mcpMain } from "../mcp/server";
import { startApp } from "./server";
import { Library } from "../v1/store";
import { pairDevice, syncAll, syncStatus } from "../v1/sync";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "mcp") {
    await mcpMain();
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
  if (cmd === "sync") {
    const home = flag(rest, "--home") || process.env.BAO_HOME || defaultHome();
    const library = new Library(home);
    const sub = positional(rest)[0];
    if (sub === "pair") {
      const code = positional(rest)[1];
      const server = flag(rest, "--server") || process.env.BAO_SYNC_SERVER || "";
      if (!code || !server) throw new Error("usage: bao sync pair CODE --server URL");
      console.log(JSON.stringify(await pairDevice(library, { code, server, name: flag(rest, "--name") }), null, 2));
      return;
    }
    if (sub === "review") {
      const id = positional(rest)[1];
      if (!id) throw new Error("usage: bao sync review ID --inputs file.json");
      const inputs = flag(rest, "--inputs") ? JSON.parse(readFileSync(flag(rest, "--inputs") || "", "utf8")) as Record<string, string> : {};
      const result = await reviewWorkflow(library, id, inputs, { startUrl: flag(rest, "--start-url") });
      console.log(JSON.stringify(result, null, 2));
      if (!result.reviewed) process.exitCode = 1;
      return;
    }
    const mode = sub === "push" || sub === "pull" ? sub : "sync";
    console.log(JSON.stringify(await syncAll(library, mode), null, 2));
    return;
  }
  if (cmd === "open") {
    const home = flag(rest, "--home") || process.env.BAO_HOME || defaultHome();
    const link = positional(rest)[0] || "";
    const id = link.replace(/^bao:\/\/workflow\//, "");
    if (!id || id === link && !link.startsWith("bao://")) throw new Error("usage: bao open bao://workflow/<id>");
    const library = new Library(home);
    try {
      const doc = library.read(id);
      console.log(`${doc.name}\nbao://workflow/${doc.id}`);
    } catch {
      console.log(`bao://workflow/${id}`);
    }
    const status = syncStatus(library);
    if (status.server) console.log(`${status.server}/marketplace/${id}`);
    return;
  }
  if (cmd === "replay") {
    console.log("use the app replay screen, or POST /api/replay");
    return;
  }
  console.error("usage: bao serve [--home dir] [--port n] | bao mcp | bao sync [pair CODE --server URL | push | pull | review ID --inputs file] | bao open bao://workflow/<id>");
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith("--")) {
      i += 1;
      continue;
    }
    if (args[i]) out.push(args[i] as string);
  }
  return out;
}

function defaultHome(): string {
  const { homedir } = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return path.join(homedir(), ".local", "share", "bao");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
