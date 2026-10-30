import path from "node:path";

/** Where docs/mac-build.md installs Bao. */
export const DEFAULT_APP = "/Applications/Bao.app";

/** The Bao.app that holds file, when file is in the server copy staged at Contents/Resources/bao. */
export function appBundleOf(file: string): string | undefined {
  return /^(.*\.app)\/Contents\/Resources\/bao\/src\//.exec(path.resolve(file))?.[1];
}

/** The launcher agents start as the bao MCP server (desktop/packaging/macos/bao-mcp.c). */
export function mcpLauncher(app: string): string {
  return path.join(app, "Contents", "MacOS", "bao-mcp");
}
