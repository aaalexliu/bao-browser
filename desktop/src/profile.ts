// App-owned Chrome profile.
//
// Real runs persist logins in a directory Bao creates. That directory is never
// the user's daily Chrome profile. Tests and the spike 1 demo pass an explicit
// fresh temp dir and delete it when the run ends (docs/desktop-design.md §4).

import { homedir } from "node:os";
import path from "node:path";

/** Daily-driver profile roots. Launch refuses anything inside these. */
export function dailyChromeProfileRoots(): string[] {
  const home = homedir();
  return [
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "AppData", "Local", "Google", "Chrome", "User Data"),
  ];
}

/**
 * Where a non-demo run stores the profile.
 * 1. BAO_PROFILE_DIR
 * 2. macOS ~/Library/Application Support/Bao/chrome-profile
 * 3. Windows %APPDATA%/Bao/chrome-profile
 * 4. Linux $XDG_DATA_HOME/bao/chrome-profile (default ~/.local/share/bao/chrome-profile)
 */
export function appOwnedProfileDir(): string {
  const override = process.env.BAO_PROFILE_DIR;
  if (override && override.trim()) return path.resolve(override);
  const home = homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Bao", "chrome-profile");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Bao", "chrome-profile");
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdg, "bao", "chrome-profile");
}

export function assertNotDailyChrome(dir: string): void {
  const resolved = path.resolve(dir);
  for (const root of dailyChromeProfileRoots()) {
    const abs = path.resolve(root);
    if (resolved === abs || resolved.startsWith(abs + path.sep)) {
      throw new Error(`Refusing to launch against the daily Chrome profile (${resolved}).`);
    }
  }
}
