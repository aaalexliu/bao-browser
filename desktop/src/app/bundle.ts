import { readFileSync } from "node:fs";
import path from "node:path";

/** Where docs/mac-build.md installs Bao. */
export const DEFAULT_APP = "/Applications/Bao.app";

/** The Bao.app that holds file, when file is in the server copy staged at Contents/Resources/bao. */
export function appBundleOf(file: string): string | undefined {
  return /^(.*\.app)\/Contents\/Resources\/bao\/src\//.exec(path.resolve(file))?.[1];
}

/** The version package-app.sh stamps into the Info.plist of the Bao.app that holds file, or dev outside a Bao.app. */
export function baoVersion(file: string): string {
  const app = appBundleOf(file);
  if (!app) return "dev";
  const plist = path.join(app, "Contents", "Info.plist");
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"))?.[1];
  if (!version) throw new Error(`${plist} has no CFBundleShortVersionString`);
  return version;
}

/** The launcher agents start as the bao MCP server (desktop/packaging/macos/bao-mcp.c). */
export function mcpLauncher(app: string): string {
  return path.join(app, "Contents", "MacOS", "bao-mcp");
}
