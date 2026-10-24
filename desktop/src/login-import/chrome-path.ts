import { homedir } from "node:os";
import path from "node:path";

/** Daily Chrome user-data directory. Reading it still requires an import click. */
export function defaultChromeUserData(): string {
  const override = process.env.BAO_CHROME_USER_DATA;
  if (override && override.trim()) return path.resolve(override);
  const home = homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(local, "Google", "Chrome", "User Data");
  }
  return path.join(home, ".config", "google-chrome");
}
