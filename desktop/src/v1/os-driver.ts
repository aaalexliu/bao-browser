// Linux AT-SPI driver. Presses by role and name. Never by the stored coordinate.

import { fromAtspiNode, assignSiblingIndex, lookup, normRole } from "./identity";
import type { HealNotice } from "./replay";
import type { Driver, LiveTree } from "./replay";
import type { FileArg, Identity } from "./schema";
import { osNodes, osPress, osSetText, type OsNode } from "../proxy/os";
import { notifyOs } from "./browser-driver";

export class AtspiDriver implements Driver {
  constructor(
    private readonly bin: string,
    private readonly screen: string,
    private readonly onNotify?: (notice: HealNotice) => void,
  ) {}

  async tree(): Promise<LiveTree> {
    const raw = await osNodes(this.bin, this.screen) as OsNode[];
    const nodes = assignSiblingIndex(raw.map((node) => fromAtspiNode(node)));
    const texts = nodes.map((node) => node.name || "").filter(Boolean);
    return { nodes, texts, values: [], url: "desktop://screen" };
  }

  async snapshot() {
    const tree = await this.tree();
    return { ax: tree.nodes.map((node) => ({ role: node.role, name: node.name, app: node.app })) };
  }

  async click(node: Identity): Promise<void> {
    await osPress(this.bin, this.screen, node.app || "", node.role, node.name || "");
  }

  async fill(node: Identity, text: string): Promise<void> {
    await this.setText(node.app || "", node.role, node.name || "", text);
  }

  async key(): Promise<void> {
    throw new Error("page keys are not an AT-SPI press");
  }

  async upload(): Promise<void> {
    throw new Error("use setText for a GTK file dialog");
  }

  async drop(_node: Identity, _files: FileArg[]): Promise<void> {
    throw new Error("native drag onto a window is not available on this Linux driver");
  }

  async digits(app: string | undefined, role: string, text: string): Promise<void> {
    for (const ch of text) {
      const tree = await this.tree();
      const query: Identity = { surface: "atspi", role, name: ch, app, path: [] };
      const hit = lookup(query, tree.nodes);
      const exact = uniqueNamedRole(tree.nodes, app, role, ch);
      const node = hit.ok && hit.index != null ? tree.nodes[hit.index] : hit.reason === "tie" ? exact : undefined;
      if (!node) throw new Error(`digit ${ch} ${hit.reason || "missing"}`);
      await this.click(node);
      await sleep(180);
    }
  }

  async check(): Promise<void> {
    throw new Error("check is a DOM action");
  }

  async setText(app: string, role: string, name: string, value: string): Promise<void> {
    await osSetText(this.bin, this.screen, app, role, name, value);
  }

  async notify(notice: HealNotice): Promise<void> {
    this.onNotify?.(notice);
    await notifyOs(notice.title, notice.body);
  }
}

/** The scorer ties a button with the label of the same name. Role plus name is one control. */
export function uniqueNamedRole(nodes: Identity[], app: string | undefined, role: string, name: string): Identity | undefined {
  const hits = nodes.filter((node) => {
    if (app && node.app && node.app.toLowerCase() !== app.toLowerCase()) return false;
    return normRole(node.role) === normRole(role) && (node.name || "") === name;
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
