// Playwright driver. The scorer stays in Node. The page only dumps a tree and
// receives one action on the element the scorer already accepted.

import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { dumpPage, type DomDump } from "./dom-page";
import { assignSiblingIndex } from "./identity";
import type { FailureSnapshot } from "./heal";
import type { Driver, HealNotice, LiveTree } from "./replay";
import type { FileArg, Identity } from "./schema";

export interface FileProof {
  action: "upload" | "drop";
  name: string;
  via: "input.files" | "echo";
}

export class BrowserDriver implements Driver {
  private handles = new WeakMap<Identity, string>();
  readonly proofs: FileProof[] = [];

  constructor(private readonly page: Page, private readonly onNotify?: (notice: HealNotice) => void) {}

  async tree(): Promise<LiveTree> {
    const dump = await this.page.evaluate(dumpPage);
    const nodes = assignSiblingIndex(dump.nodes.map((node) => toIdentity(node)));
    nodes.forEach((node, index) => {
      const handle = dump.nodes[index]?.handle;
      if (handle) this.handles.set(node, handle);
    });
    const values = dump.values.flatMap((item) => {
      const identity = nodes.find((node) => this.handles.get(node) === item.handle);
      return identity ? [{ identity, value: item.value }] : [];
    });
    return { nodes, url: dump.url, texts: dump.texts, values };
  }

  async snapshot(): Promise<FailureSnapshot> {
    const png = await this.page.screenshot({ type: "png" });
    const dump = await this.page.evaluate(dumpPage);
    let ax: string | undefined;
    try {
      ax = await this.page.locator("body").ariaSnapshot();
    } catch {
      ax = undefined;
    }
    return {
      screenshot: png.toString("base64"),
      screenshotRef: `png:${png.length}`,
      dom: dump.nodes.map((node) => ({
        role: node.role,
        name: node.name,
        testId: node.testId,
        id: node.id,
        text: node.text,
      })),
      ax,
    };
  }

  async click(node: Identity): Promise<void> {
    await this.page.locator(this.sel(node)).click();
  }

  async fill(node: Identity, text: string): Promise<void> {
    await this.page.locator(this.sel(node)).fill(text);
  }

  async key(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async upload(node: Identity, files: FileArg[]): Promise<void> {
    const want = files[0]?.name || "";
    if (!want) throw new Error("upload has no file");
    const loc = this.page.locator(this.sel(node));
    await loc.setInputFiles(files.map((file) => file.path));
    const got = await loc.evaluate((el, name) => {
      const input = el instanceof HTMLInputElement && el.type === "file"
        ? el
        : el.querySelector("input[type=file]");
      const field = input instanceof HTMLInputElement ? input : null;
      const file = field?.files?.[0];
      if (field && file && file.name === name) field.dispatchEvent(new Event("change", { bubbles: true }));
      return file?.name || "";
    }, want);
    if (got !== want) throw new Error(`upload did not land: wanted ${want}, input.files[0].name is ${got || "empty"}`);
    this.proofs.push({ action: "upload", name: got, via: "input.files" });
  }

  async drop(node: Identity, files: FileArg[]): Promise<void> {
    const want = files[0]?.name || "";
    if (!want) throw new Error("drop has no file");
    const payload = files.map((file) => ({
      name: file.name,
      b64: readFileSync(file.path).toString("base64"),
    }));
    const handle = this.handle(node);
    const landed = await this.page.evaluate(({ handle, payload, want }) => {
      const el = document.querySelector(`[data-bao-i="${handle}"]`);
      if (!el) throw new Error("drop target missing");
      const before = document.body.innerText || "";
      const dt = new DataTransfer();
      for (const file of payload) {
        const bin = atob(file.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], file.name));
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      const input = el instanceof HTMLInputElement && el.type === "file" ? el : null;
      const fromInput = input?.files?.[0]?.name || "";
      const after = document.body.innerText || "";
      return { fromInput, echoed: after.includes(want) && after !== before };
    }, { handle, payload, want });
    if (landed.fromInput !== want && !landed.echoed) {
      throw new Error(`drop did not land: wanted ${want}`);
    }
    this.proofs.push({ action: "drop", name: want, via: landed.fromInput === want ? "input.files" : "echo" });
  }

  async digits(): Promise<void> {
    throw new Error("digits are an OS action");
  }

  async check(node: Identity, checked: boolean): Promise<void> {
    await this.page.locator(this.sel(node)).setChecked(checked);
  }

  async notify(notice: HealNotice): Promise<void> {
    this.onNotify?.(notice);
    await notifyOs(notice.title, notice.body);
  }

  private handle(node: Identity): string {
    const handle = this.handles.get(node);
    if (!handle) throw new Error("element handle expired; the tree was dumped again");
    return handle;
  }

  private sel(node: Identity): string {
    return `[data-bao-i="${this.handle(node)}"]`;
  }
}

export async function notifyOs(title: string, body: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]]
    : ["notify-send", ["-a", "Bao", "-u", "normal", "-t", "15000", title, body]];
  await new Promise<void>((resolve) => {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function toIdentity(node: DomDump): Identity {
  return {
    surface: "dom",
    role: node.role,
    name: node.name,
    testId: node.testId,
    id: node.id,
    nameAttr: node.nameAttr,
    tag: node.tag,
    label: node.label,
    text: node.text,
    cssPath: node.cssPath,
    path: node.path,
    value: node.value,
  };
}
