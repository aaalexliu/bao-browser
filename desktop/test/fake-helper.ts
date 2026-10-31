// BaoOSHelper as the daily Chrome shows it to a live session: the remote
// debugging checkbox is on, and the Allow dialog appears once bao connects.
// It records each call and presses nothing on this Mac.

import type { ChromeAx } from "../src/cdp-live/ax";
import { ALLOW_BUTTON, ALLOW_DIALOG_TITLE, REMOTE_CHECKBOX } from "../src/cdp-live/consent";
import type { AxHit, AxNode } from "../src/proxy/os-macos";

function axNode(role: string, name: string, value = "", window = ""): AxNode {
  return {
    role,
    subrole: "",
    title: "",
    description: "",
    identifier: "",
    name,
    value,
    actions: [],
    frame: null,
    path: window ? [{ role: "AXWindow", name: window }] : [],
    pid: 1,
    app: "com.google.Chrome",
    useful: true,
  };
}

export function fakeChromeHelper(opts: { accessibility?: boolean } = {}): { helper: ChromeAx; calls: string[] } {
  const calls: string[] = [];
  let reads = 0;
  const helper: ChromeAx = {
    exec: async (args) => {
      calls.push(args.join(" "));
      throw new Error("unexpected Automation call");
    },
    screenLocked: async () => {
      calls.push("screen-locked");
      return false;
    },
    permissions: async (prompt: boolean): Promise<AxHit> => {
      calls.push(`permissions ${prompt}`);
      return { ok: true, accessibility: opts.accessibility ?? true };
    },
    nodes: async (): Promise<AxHit> => {
      calls.push("nodes");
      reads += 1;
      const nodes = [axNode("AXWindow", "Instacart"), axNode("AXCheckBox", REMOTE_CHECKBOX, "1", "Inspect with Chrome Developer Tools")];
      if (reads > 1) {
        nodes.push(axNode("AXWindow", ALLOW_DIALOG_TITLE), axNode("AXButton", ALLOW_BUTTON, "", ALLOW_DIALOG_TITLE));
      }
      return { ok: true, nodes };
    },
    press: async (target: { role: string; name: string }): Promise<AxHit> => {
      calls.push(`press ${target.role} ${target.name}`);
      return { ok: true, element: axNode(target.role, target.name, "", ALLOW_DIALOG_TITLE) };
    },
  };
  return { helper, calls };
}
