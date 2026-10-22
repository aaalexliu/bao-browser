// Login redirect check. The pathname is the page, so a `next` query is not a match.

import type { Precondition, ReplayArgs, WorkflowV2 } from "./schema";

export function urlPath(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    const cut = url.split("?")[0] || "";
    return cut.startsWith("/") ? cut : "";
  }
}

export function pathMatches(url: string | undefined, match: string): boolean {
  if (!match) return false;
  const path = urlPath(url);
  if (!path) return false;
  return path === match || path.endsWith(match);
}

/**
 * Logged-out /freeze lands on /login. That is phase `auth`, not a locate miss.
 * A query that mentions /freeze does not count as being on the freeze page.
 */
export function authPreconditionMiss(pre: Precondition | undefined, url: string | undefined): string | undefined {
  if (!pre || pre.phase !== "auth" || !pre.match) return undefined;
  if (pathMatches(url, pre.match)) return undefined;
  const path = urlPath(url);
  if (path === "/login" || path.endsWith("/login")) return "redirected to login";
  return undefined;
}

export function secretInputName(workflow: WorkflowV2, preferred?: string): string | undefined {
  if (preferred && workflow.inputs.some((input) => input.name === preferred && input.type === "secret")) {
    return preferred;
  }
  const named = workflow.inputs.find((input) => input.type === "secret" && /pass|secret/i.test(input.name));
  return named?.name || workflow.inputs.find((input) => input.type === "secret")?.name;
}

export function secretArg(workflow: WorkflowV2, args: ReplayArgs, preferred?: string): string {
  const name = secretInputName(workflow, preferred);
  if (!name) return "";
  const value = args[name];
  return typeof value === "string" ? value : "";
}

export function textArg(args: ReplayArgs, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}
