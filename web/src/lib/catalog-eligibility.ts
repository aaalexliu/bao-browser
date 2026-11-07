export interface WorkflowSearchContext {
  extensionLinked: boolean;
  pageEngine?: "old" | "agent-browser";
  relay?: boolean;
}

export function catalogContext(params: URLSearchParams): WorkflowSearchContext {
  return {
    extensionLinked: params.get("extensionLinked") === "true",
    pageEngine: params.get("pageEngine") === "agent-browser" ? "agent-browser" : "old",
    relay: params.get("relay") === "true",
  };
}

export function workflowSearchEligible(workflow: { driver?: string | null; provenance?: string }, context: WorkflowSearchContext): boolean {
  if (workflow.provenance === "fixture" || workflow.driver === "cdp-live") return false;
  if (context.pageEngine === "agent-browser" && !(context.relay && workflow.driver === "extension")) return false;
  return workflow.driver !== "extension" || context.extensionLinked;
}
