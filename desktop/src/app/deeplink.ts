// bao://workflow/<id> opens that workflow. bao://import/<id> shows the import
// sheet and does not save until the questions are answered.

import { migrate, type WorkflowV2 } from "../v1/schema";
import { importQuestions, type ImportQuestion } from "../../../web/src/lib/import-sheet";

export interface BaoLink {
  kind: "workflow" | "import";
  id: string;
}

export interface OpenedView {
  kind: "workflow" | "import";
  id: string;
  name: string;
  link: string;
  importLink: string;
  questions: ImportQuestion[];
  saved: boolean;
}

export function parseBaoLink(link: string): BaoLink | null {
  const match = link.trim().match(/^bao:\/\/(workflow|import)\/([A-Za-z0-9_-]+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as "workflow" | "import", id: match[2] };
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
