import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** --home, then BAO_HOME, then the platform default the app window uses. */
export function resolveBaoHome(input: {
  homeFlag?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
} = {}): string {
  const flag = input.homeFlag?.trim();
  if (flag) return flag;
  const env = input.env || process.env;
  const fromEnv = env.BAO_HOME?.trim();
  if (fromEnv) return fromEnv;
  const home = input.homedir || homedir();
  const platform = input.platform || process.platform;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "bao");
  return path.join(home, ".local", "share", "bao");
}

/** Port of a running app. The flag's home wins, then BAO_HOME, then the platform default. */
export function baoServerPort(homeFlag?: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const homes = [
    homeFlag,
    env.BAO_HOME,
    process.platform === "darwin" ? path.join(homedir(), "Library", "Application Support", "bao") : undefined,
    path.join(homedir(), ".local", "share", "bao"),
  ].filter((home): home is string => !!home?.trim());
  for (const home of homes) {
    const file = path.join(home, "server.json");
    if (!existsSync(file)) continue;
    try {
      const port = Number((JSON.parse(readFileSync(file, "utf8")) as { port?: number }).port);
      if (port > 0) return port;
    } catch {
      continue;
    }
  }
  return undefined;
}
