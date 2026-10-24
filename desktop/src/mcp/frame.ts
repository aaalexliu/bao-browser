// MCP stdio is newline-delimited JSON. Content-Length is the LSP framing.
// Readers still accept a Content-Length frame so an older client is not stuck.

export type RpcFraming = "headers" | "json";

export function frameRpc(msg: unknown, framing: RpcFraming): string {
  const json = JSON.stringify(msg);
  if (framing === "json") return `${json}\n`;
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** One MCP message. A `{` starts a JSON message. Anything else is a header frame. */
export function takeRpcChunk(buf: Buffer, framing: RpcFraming | null): { body: string; rest: Buffer; framing: RpcFraming } | null {
  const mode = framing || detectFraming(buf);
  if (!mode) return null;
  return mode === "json" ? takeJsonRpc(buf) : takeHeaderRpc(buf);
}

function detectFraming(buf: Buffer): RpcFraming | null {
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0d || buf[i] === 0x0a)) i++;
  if (i >= buf.length) return null;
  return buf[i] === 0x7b ? "json" : "headers";
}

function takeJsonRpc(buf: Buffer): { body: string; rest: Buffer; framing: RpcFraming } | null {
  const text = buf.toString("utf8");
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (i >= text.length || text[i] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const end = j + 1;
        let byteEnd = Buffer.byteLength(text.slice(0, end));
        if (buf[byteEnd] === 0x0a) byteEnd += 1;
        else if (buf[byteEnd] === 0x0d && buf[byteEnd + 1] === 0x0a) byteEnd += 2;
        return { body: text.slice(i, end), rest: buf.subarray(byteEnd), framing: "json" };
      }
    }
  }
  return null;
}

function takeHeaderRpc(buf: Buffer): { body: string; rest: Buffer; framing: RpcFraming } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = buf.subarray(0, headerEnd).toString("utf8");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length = Number(match[1]);
  const start = headerEnd + 4;
  if (buf.length < start + length) return null;
  return {
    body: buf.subarray(start, start + length).toString("utf8"),
    rest: buf.subarray(start + length),
    framing: "headers",
  };
}
