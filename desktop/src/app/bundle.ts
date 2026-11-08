import { readFileSync } from "node:fs";
import path from "node:path";

/** Where docs/mac-build.md installs Bao. */
export const DEFAULT_APP = "/Applications/Bao.app";

/** The Bao.app that holds file, when file is in the server copy staged at Contents/Resources/bao. */
export function appBundleOf(file: string): string | undefined {
  return /^(.*\.app)\/Contents\/Resources\/bao\/src\//.exec(path.resolve(file))?.[1];
}

/** The version package-app.sh stamps into the Info.plist of app, or undefined when it cannot be read. */
export function appVersion(app: string): string | undefined {
  try {
    const plist = readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  } catch {
    return undefined;
  }
}

/** The version of the Bao.app that holds file: dev outside a Bao.app, unknown when its Info.plist has none. */
export function baoVersion(file: string): string {
  const app = appBundleOf(file);
  return app ? appVersion(app) ?? "unknown" : "dev";
}

/** The launcher agents start as the bao MCP server (desktop/packaging/macos/bao-mcp.c). */
export function mcpLauncher(app: string): string {
  return path.join(app, "Contents", "MacOS", "bao-mcp");
}
