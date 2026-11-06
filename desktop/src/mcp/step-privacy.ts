import { FILE_BINDING } from "../../../shared/bindings";
import { secretSavedField } from "../../../shared/saved-secrets";
import type { WorkflowStep, WorkflowV2 } from "../v1/schema";
import type { StoredRun } from "../v1/store";

function* fields(value: unknown, excluded?: unknown): Generator<unknown> {
  if (value === excluded) return;
  yield value;
  if (Array.isArray(value)) {
    for (const child of value) yield* fields(child, excluded);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) yield* fields(child, excluded);
  }
}

/** Shared by marketplace evidence and the MCP viewer. Unknown capture steps are not shareable. */
export function privateStep(workflow: WorkflowV2, step: WorkflowStep, run: Pick<StoredRun, "receipts" | "failure" | "envelope" | "steps">): boolean {
  const secrets = new Set(workflow.inputs.filter((input) => input.type === "secret").map((input) => input.name));
  const names = new Set(workflow.inputs.map((input) => input.name));
  type Source = NonNullable<WorkflowStep["forEach"]>["over"];
  const scopes: { step: WorkflowStep; row?: Source; nodes: unknown[] }[] = [];
  const walk = (steps: WorkflowStep[], row?: Source): void => {
    for (const item of steps) {
      scopes.push({ step: item, row, nodes: [...fields(item, item.forEach?.steps)] });
      if (item.forEach) walk(item.forEach.steps, item.forEach.over);
    }
  };
  walk(workflow.steps);
  const structural = (nodes: unknown[]): boolean => nodes.some((node) => secretSavedField(node)
    || (node !== null && typeof node === "object" && "sensitive" in node && node.sensitive === true));
  const tokens = (value: string): string[] => [...value.matchAll(FILE_BINDING)].map((match) => match[1]!);
  const references = (nodes: unknown[]): string[] => nodes.flatMap((value) => typeof value === "string" ? [value, ...tokens(value)] : []);
  const columns = new Map<string, Set<string>>();
  for (const { row, nodes } of scopes) {
    if (!structural(nodes)) continue;
    for (const token of references(nodes)) {
      if (names.has(token)) secrets.add(token);
      if (row && token.startsWith("row.")) {
        const key = `${row.kind}:${row.name}`;
        const hidden = columns.get(key) || new Set<string>();
        hidden.add(token.slice(4));
        columns.set(key, hidden);
      }
    }
  }
  const bound = (nodes: unknown[], row?: Source): boolean => references(nodes).some((token) => secrets.has(token)
    || Boolean(row && token.startsWith("row.") && ((row.kind === "input" && secrets.has(row.name))
      || columns.get(`${row.kind}:${row.name}`)?.has(token.slice(4)))));
  const hidden = (item: WorkflowStep): boolean => {
    const scope = scopes.find((candidate) => candidate.step === item)!;
    return structural(scope.nodes) || bound(scope.nodes, scope.row) || Boolean(item.forEach?.steps.some(hidden));
  };
  const recorded = [...(run.receipts || []), run.failure].some((item) =>
    item !== null && typeof item === "object" && "stepId" in item && item.stepId === step.id)
    || run.steps.some((item) => item !== null && typeof item === "object" && "id" in item && item.id === step.id
      && ("readBack" in item || ("status" in item && ["paused", "failed", "timeout", "timed-out"].includes(String(item.status)))));
  const readBack = [...fields(workflow.readBack)];
  return hidden(step)
    || ((recorded || run.envelope?.step === step.id || workflow.steps.at(-1)?.id === step.id)
      && (structural(readBack) || bound(readBack)));
}
