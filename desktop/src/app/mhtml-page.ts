// Turns a stored MHTML archive into one HTML page. Bao's window is a WKWebView, which does not open MHTML.

interface Part {
  type: string;
  /** The names other parts use for this one: its `Content-Location`, and `cid:` plus its `Content-ID`. */
  names: string[];
  body: Buffer;
}

function header(head: string, name: string): string {
  return new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";
}

function decode(body: string, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body, "base64");
  if (encoding !== "quoted-printable") return Buffer.from(body, "latin1");
  const text = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(text, "latin1");
}

function parts(mhtml: Buffer): Part[] {
  const raw = mhtml.toString("latin1");
  const boundary = /boundary="([^"]+)"/i.exec(raw.slice(0, raw.search(/\r?\n\r?\n/)))?.[1];
  if (!boundary) return [];
  return raw.split(`--${boundary}`).slice(1).flatMap((chunk) => {
    const split = /\r?\n\r?\n/.exec(chunk);
    if (!split) return [];
    const head = chunk.slice(0, split.index);
    const id = header(head, "Content-ID").replace(/^<|>$/g, "");
    const names = [header(head, "Content-Location"), id ? `cid:${id}` : ""].filter(Boolean);
    const body = chunk.slice(split.index + split[0].length).replace(/\r?\n$/, "");
    return [{ type: header(head, "Content-Type").split(";")[0]!.trim().toLowerCase(), names, body: decode(body, header(head, "Content-Transfer-Encoding").toLowerCase()) }];
  });
}

/** The ways a page or stylesheet quotes a URL. A bare match could cut a longer URL that starts with the same text. */
const QUOTES = [['"', '"'], ["'", "'"], ["(", ")"], ["&quot;", "&quot;"]] as const;

/** A `<link>` that still points at the web: a preconnect, a preload, an icon. WebKit opens a preconnect whatever the page's policy says. */
const WEB_LINK = /<link\b[^>]*\bhref=["']https?:[^>]*>/gi;

/**
 * The archive's first page with every stylesheet, picture and frame it holds written into it as a `data:` URL.
 * Chrome saves an archive with no scripts. A `<link>` to anything the archive does not hold is dropped. Other
 * elements keep such an address, so the caller must stop the page from loading it.
 */
export function mhtmlPage(mhtml: Buffer): string | undefined {
  const all = parts(mhtml);
  const main = all[0];
  if (main?.type !== "text/html") return undefined;
  const inlined = (part: Part, within: readonly Part[]): string => {
    let text = part.body.toString("utf8");
    for (const other of all) {
      if (other === part || within.includes(other)) continue;
      let uri: string | undefined;
      for (const name of other.names.flatMap((value) => value.includes("&") ? [value, value.replace(/&/g, "&amp;")] : [value])) {
        for (const [open, close] of QUOTES) {
          const quoted = `${open}${name}${close}`;
          if (!text.includes(quoted)) continue;
          uri ??= dataUri(other, [...within, part]);
          text = text.split(quoted).join(`${open}${uri}${close}`);
        }
      }
    }
    return part.type === "text/html" ? text.replace(WEB_LINK, "") : text;
  };
  const dataUri = (part: Part, within: readonly Part[]): string => {
    const text = part.type === "text/html" || part.type === "text/css";
    const body = text ? Buffer.from(inlined(part, within)) : part.body;
    return `data:${part.type}${text ? ";charset=utf-8" : ""};base64,${body.toString("base64")}`;
  };
  return inlined(main, []);
}
