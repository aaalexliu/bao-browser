/** Global flags pinned agent-browser 0.41.0 strips before it reads a command. A tab reference hidden behind one of them is still that command. */
export const GLOBAL_BOOL_FLAGS = new Set([
  "--json", "--headed", "--webgpu", "--no-webmcp", "--debug", "--ignore-https-errors", "--allow-file-access", "--hide-scrollbars",
  "--auto-connect", "--pin-tab", "--no-pin-tab", "--no-ca-cert", "--use-system-ca", "--annotate", "--content-boundaries", "--confirm-interactive",
  "--no-auto-dialog", "-v", "--verbose", "-q", "--quiet", "--offline", "--quick", "--fix",
]);
export const GLOBAL_VALUE_FLAGS = new Set([
  "--session", "--restore-save", "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--namespace", "--headers", "--executable-path",
  "--cdp", "--extension", "--init-script", "--enable", "--profile", "--state", "--proxy", "--proxy-bypass", "--args", "--user-agent", "-p", "--provider",
  "--device", "--session-name", "--color-scheme", "--download-path", "--max-output", "--allowed-domains", "--action-policy", "--confirm-actions", "--config",
  "--engine", "--input-mode", "--screenshot-dir", "--screenshot-quality", "--screenshot-format", "--idle-timeout", "--ca-cert", "--model",
]);

export type TabCommandAction = "list" | "new" | "close" | "switch";

/** The tab words left after pinned agent-browser 0.41.0 removes global flags, plus whether that command asked for JSON. */
export function stripGlobalFlags(args: readonly string[]): { args: string[]; json: boolean } {
  const cleaned: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--restore=")) continue;
    if (GLOBAL_VALUE_FLAGS.has(arg)) { i += 1; continue; }
    if (arg === "--restore") continue;
    if (GLOBAL_BOOL_FLAGS.has(arg)) {
      const next = args[i + 1];
      const valued = next === "true" || next === "false";
      if (arg === "--json") json = valued ? next === "true" : true;
      if (valued) i += 1;
      continue;
    }
    cleaned.push(arg);
  }
  return { args: cleaned, json };
}

/** The tab action the pinned CLI runs: flags first, then list, new, close, or a switch reference. No verb is a list. */
export function tabCommandAction(args: readonly string[] | undefined): TabCommandAction {
  const head = stripGlobalFlags(args ?? []).args[0];
  if (head === undefined || head === "list") return "list";
  if (head === "new") return "new";
  if (head === "close") return "close";
  return "switch";
}
