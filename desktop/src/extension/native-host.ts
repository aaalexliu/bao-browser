// Chrome spawns this process. Stdin and stdout are length-prefixed frames.
// The first socket frame is the auth token. The extension never sees it.
// Logs go to stderr. Chrome treats stdout as the protocol.

import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { EXTENSION_ID, extensionOrigin } from "./protocol";
import { FrameDecoder, encodeFrame } from "./frames";

export function originArg(argv: readonly string[], extensionId = EXTENSION_ID): { ok: true } | { ok: false; reason: string } {
  const want = extensionOrigin(extensionId);
  const mentioned = argv.filter((arg) => arg.includes("chrome-extension://"));
  if (mentioned.length === 0) return { ok: true };
  const good = mentioned.every((arg) => arg.includes(want));
  return good ? { ok: true } : { ok: false, reason: "origin" };
}

export function acceptAuth(message: unknown, token: string, extensionId: string): boolean {
  if (!message || typeof message !== "object") return false;
  const body = message as { type?: string; token?: string; extensionId?: string };
  return body.type === "auth" && body.token === token && body.extensionId === extensionId;
}

interface HostArgs {
  socketPath: string;
  tokenPath: string;
  extensionId: string;
}

export function parseHostArgs(argv: readonly string[]): HostArgs {
  const read = (name: string): string => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : "";
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  return {
    socketPath: read("--socket"),
    tokenPath: read("--token"),
    extensionId: read("--extension-id"),
  };
}

export function runHost(argv: readonly string[], stdin = process.stdin, stdout = process.stdout): void {
  const origin = originArg(argv);
  if (!origin.ok) {
    process.stderr.write(`bao host refused ${origin.reason}\n`);
    process.exit(1);
    return;
  }
  let args: HostArgs;
  try {
    args = parseHostArgs(argv);
  } catch (err) {
    process.stderr.write(`bao host ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }
  let token = "";
  try {
    token = readFileSync(args.tokenPath, "utf8").trim();
  } catch {
    process.stderr.write("bao host token unreadable\n");
    process.exit(1);
    return;
  }
  if (!token) {
    process.stderr.write("bao host token empty\n");
    process.exit(1);
    return;
  }
  const socket: Socket = connect(args.socketPath);
  const fromChrome = new FrameDecoder();
  const fromBao = new FrameDecoder();
  let authed = false;
  const pending: unknown[] = [];
  const fail = (message: string) => {
    process.stderr.write(`bao host ${message}\n`);
    socket.destroy();
    process.exit(1);
  };
  socket.on("error", () => fail("socket"));
  socket.on("connect", () => {
    socket.write(encodeFrame({ type: "auth", token, extensionId: args.extensionId }));
  });
  socket.on("data", (chunk) => {
    let frames: unknown[];
    try {
      frames = fromBao.push(chunk);
    } catch (err) {
      fail(err instanceof Error ? err.message : "frame");
      return;
    }
    for (const frame of frames) {
      if (!authed) {
        const body = frame as { type?: string };
        if (body.type !== "auth-ok") {
          fail("auth rejected");
          return;
        }
        authed = true;
        for (const message of pending) socket.write(encodeFrame(message));
        pending.length = 0;
        continue;
      }
      stdout.write(encodeFrame(frame));
    }
  });
  socket.on("close", () => process.exit(0));
  stdin.on("data", (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = fromChrome.push(chunk);
    } catch (err) {
      fail(err instanceof Error ? err.message : "frame");
      return;
    }
    for (const frame of frames) {
      if (!authed) pending.push(frame);
      else socket.write(encodeFrame(frame));
    }
  });
  stdin.on("end", () => {
    socket.end();
  });
}

if (require.main === module) {
  runHost(process.argv);
}
