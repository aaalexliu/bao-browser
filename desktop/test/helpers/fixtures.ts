import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { laneChildEnv } from "../runtime";

export async function syntheticChromeProfile(root: string, profile: { name: string; user_name?: string }): Promise<string> {
  await mkdir(path.join(root, "Default"), { recursive: true });
  await writeFile(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: profile } } }));
  await writeFile(path.join(root, "Default", "Preferences"), "{}");
  return root;
}

export function baoFixtureEnv(dirs: { user: string; library: string; profiles: string }, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...laneChildEnv("hermetic", parent),
    HOME: dirs.user,
    BAO_HOME: dirs.library,
    BAO_CHROME_USER_DATA: dirs.profiles,
    BAO_AGENT_BROWSER_PROFILE_ROOT: dirs.profiles,
  };
}
