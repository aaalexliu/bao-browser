// bao://workflow/<id> opens that workflow. bao://import/<id> shows the import
// sheet and does not save until the questions are answered.
// bao://run/<id>?inputs=<json> opens the run form. Secret keys are refused.

import { migrate, type WorkflowV2 } from "../v1/schema";
import { importQuestions, type ImportQuestion } from "../../../web/src/lib/import-sheet";

export interface BaoLink {
  kind: "workflow" | "import" | "run";
  id: string;
  inputs?: Record<string, string | number>;
}

export interface OpenedView {
  kind: "workflow" | "import" | "run";
  id: string;
  name: string;
  link: string;
  importLink: string;
  questions: ImportQuestion[];
  saved: boolean;
  /** Non-secret values from a run link. Secrets are never copied here. */
  inputs?: Record<string, string>;
}

export function parseBaoLink(link: string): BaoLink | null {
  const match = link.trim().match(/^bao:\/\/(workflow|import|run)\/([A-Za-z0-9_-]+)(\?[^#]*)?$/);
  if (!match?.[1] || !match[2]) return null;
  const kind = match[1] as BaoLink["kind"];
  const id = match[2];
  if (kind !== "run" || !match[3]) return { kind, id };
  const raw = new URLSearchParams(match[3].slice(1)).get("inputs");
  if (!raw) return { kind, id, inputs: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const inputs: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" && typeof value !== "number") return null;
      inputs[key] = value;
    }
    return { kind, id, inputs };
  } catch {
    return null;
  }
}

export function workflowLink(id: string): string {
  return `bao://workflow/${id}`;
}

export function importLink(id: string): string {
  return `bao://import/${id}`;
}

export function decideOpen(
  link: string,
  local: WorkflowV2 | null,
  attached: unknown,
): { opened: OpenedView; pending: WorkflowV2 | null } | { error: string } {
  const parsed = parseBaoLink(link);
  if (!parsed) return { error: "usage: bao open bao://workflow/<id>" };
  const extra = attached ? safeDoc(attached) : null;
  if (extra && extra.id !== parsed.id) return { error: "id" };
  const doc = local ?? extra;
  if (!doc) return { error: "workflow not on this Mac" };
  const questions = importQuestions(doc);
  const view = {
    id: doc.id,
    name: doc.name,
    link: workflowLink(doc.id),
    importLink: importLink(doc.id),
    questions,
    saved: false,
  };
  if (parsed.kind === "run") {
    if (!local) return { error: "workflow not on this Mac" };
    const secret = (local.inputs || []).find((input) => input.type === "secret" && parsed.inputs && Object.prototype.hasOwnProperty.call(parsed.inputs, input.name));
    if (secret) {
      return { error: `Secret inputs are re-asked on this device. Remove ${secret.label || secret.name} from the link.` };
    }
    const inputs: Record<string, string> = {};
    for (const input of local.inputs || []) {
      if (input.type === "secret" || input.type === "file") continue;
      const value = parsed.inputs?.[input.name];
      if (typeof value === "string" || typeof value === "number") inputs[input.name] = String(value);
    }
    return { opened: { ...view, kind: "run", inputs }, pending: null };
  }
  if (parsed.kind === "workflow" && local) {
    return { opened: { ...view, kind: "workflow" }, pending: null };
  }
  return { opened: { ...view, kind: "import" }, pending: doc };
}

function safeDoc(raw: unknown): WorkflowV2 | null {
  try {
    const doc = migrate(raw);
    return doc.id ? doc : null;
  } catch {
    return null;
  }
}
