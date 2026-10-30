// bao serve | bao mcp | bao import-login | bao sync | bao open bao://workflow/<id>

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { reviewWorkflow } from "../mcp/catalog";
import { mcpMain } from "../mcp/server";
import { mcpBaoMain } from "../proxy/mcp-bao";
import { parseBaoLink } from "./deeplink";
import { startApp } from "./server";
import { Library } from "../v1/store";
import { pairDevice, syncAll } from "../v1/sync";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "mcp") {
    await mcpMain();
    return;
  }
  if (cmd === "mcp-ax") {
    await mcpBaoMain();
    return;
  }
  if (cmd === "mcp-live") {
    const { liveProxyMain } = await import("../mcp/live-proxy");
    await liveProxyMain(rest);
    return;
  }
  if (cmd === "live_session_start" || cmd === "live_snapshot" || cmd === "live_click" || cmd === "live_type" || cmd === "live_screenshot" || cmd === "live_stop") {
    const { runLiveCli } = await import("../mcp/live-proxy");
    await runLiveCli(cmd, rest);
    return;
  }
  if (cmd === "import-login") {
    await importLogin(rest);
    return;
  }
  if (cmd === "serve" || !cmd) {
    const home = flag(rest, "--home") || process.env.BAO_HOME || defaultHome();
    const port = Number(flag(rest, "--port") || process.env.BAO_PORT || 4787);
    const app = await startApp({ home, port, extensionHost: true });
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
      if (!code || !server) throw new Error("usage: bao sync pair CODE --server URL [--secret SECRET]");
      const secret = flag(rest, "--secret") || process.env.BAO_INVITE_SECRET;
      console.log(JSON.stringify(await pairDevice(library, { code, server, name: flag(rest, "--name"), secret }), null, 2));
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
    const link = positional(rest)[0] || "";
    if (!parseBaoLink(link)) {
      throw new Error(link.trim().startsWith("bao://run/") ? "inputs must be JSON" : "usage: bao open bao://workflow/<id>");
    }
    const port = Number(flag(rest, "--port") || process.env.BAO_PORT || readServerPort(flag(rest, "--home")) || 0);
    if (!port) {
      console.error("start Bao first");
      process.exit(1);
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link }),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    console.log(JSON.stringify(body));
    if (!res.ok || !body.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "replay") {
    console.log("use the app replay screen, or POST /api/replay");
    return;
  }
  if (cmd === "eval" && rest[0] === "drivers") {
    const { evalDrivers } = await import("../eval/drivers");
    const result = await evalDrivers(rest.slice(1));
    process.stdout.write(result.markdown);
    return;
  }
  if (cmd === "eval" && rest[0] === "intent") {
    const { evalIntent } = await import("../eval/intent/run");
    const result = await evalIntent(rest.slice(1));
    process.stdout.write(result.markdown);
    return;
  }
  if (cmd === "eval" && rest[0] === "heldout" && rest[1] === "capture") {
    const { captureHeldout } = await import("../eval/heldout/capture");
    const dir = flag(rest, "--dir") || "docs/eval/heldout/batch1";
    const tasks = flag(rest, "--tasks");
    if (tasks === "alerts") {
      const { recordAlertsTrail } = await import("../eval/heldout/record-alerts");
      await recordAlertsTrail(dir);
      return;
    }
    if (tasks === "alerts-v2") {
      const { recordAlertsV2 } = await import("../eval/heldout/record-alerts");
      await recordAlertsV2(dir);
      return;
    }
    const list = tasks === "batch6"
      ? (await import("../eval/heldout/tasks6")).HELD_TASKS_6
      : tasks === "batch5"
      ? (await import("../eval/heldout/tasks5")).HELD_TASKS_5
      : tasks === "batch4"
      ? (await import("../eval/heldout/tasks4")).HELD_TASKS_4
      : tasks === "batch3"
      ? (await import("../eval/heldout/tasks3")).HELD_TASKS_3
      : tasks === "batch2"
        ? (await import("../eval/heldout/tasks2")).HELD_TASKS_2
        : undefined;
    await captureHeldout(dir, list);
    return;
  }
  if (cmd === "eval" && rest[0] === "heldout") {
    const { evalHeldout } = await import("../eval/heldout/run");
    const result = await evalHeldout(rest.slice(1));
    process.stdout.write(result.markdown);
    return;
  }
  if (cmd === "eval" && rest[0] === "nightly") {
    const { runNightly } = await import("../eval/nightly/run");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const code = await runNightly({
      out: flag(rest, "--out") || `docs/evals/nightly/runs/${stamp}`,
      baseline: flag(rest, "--baseline") || "docs/evals/nightly/baseline",
      saveBaseline: rest.includes("--save-baseline"),
    });
    process.exitCode = code;
    return;
  }
  if (cmd === "eval" && rest[0] === "judge-agree") {
    const { runJudgeAgree } = await import("../eval/judge-agree");
    const result = await runJudgeAgree(flag(rest, "--sheet") || "docs/evals/judge-labels.md");
    console.log(result.text);
    process.exitCode = result.code;
    return;
  }
  console.error("usage: bao serve [--home dir] [--port n] | bao mcp | bao mcp-live [--home dir] | bao mcp-ax | bao live_session_start --intent text --url https://host/ --port-file DevToolsActivePort --preset generic|instacart|books | bao import-login --from chrome --domain <host> [--profile <name>] | bao sync [pair CODE --server URL | push | pull | review ID --inputs file] | bao open bao://workflow/<id> | bao open bao://import/<id> | bao open bao://run/<id>?inputs=<json> | bao eval drivers | bao eval intent | bao eval heldout capture --dir dir | bao eval heldout --dir dir --out file | bao eval heldout --judge | bao eval nightly [--save-baseline] | bao eval judge-agree");
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
