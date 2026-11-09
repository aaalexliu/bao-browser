// Fixture Chrome profiles and a fake task tab for tests of the owner's-Chrome route.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";

export type ProfileNames = Record<string, { name: string; user_name?: string }>;

/** Profile folders in a Chrome user-data-dir, listed in Local State the way Chrome lists them. */
export async function chromeProfiles(root: string, profiles: ProfileNames = { Default: { name: "Owner" } }): Promise<string> {
  for (const directory of Object.keys(profiles)) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "Local State"), JSON.stringify({ profile: { info_cache: profiles } }));
  return root;
}

/** Chrome's Device Bound Sessions table in a profile folder: one row per session, keyed by its site, such as "https://google.com 3f9a". */
export function boundSessions(profileDir: string, keys: string[]): void {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => {
    exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void;
  } };
  const db = new DatabaseSync(path.join(profileDir, "Device Bound Sessions"));
  db.exec("CREATE TABLE dbsc_session_tbl (key TEXT NOT NULL, proto BLOB NOT NULL, PRIMARY KEY(key))");
  const insert = db.prepare("INSERT INTO dbsc_session_tbl (key, proto) VALUES (?, ?)");
  for (const key of keys) insert.run(key, Buffer.from("session"));
  db.close();
}

/** A fake owner's Chrome opens Bao's task tab the way the real route does when the chosen profile is Chrome's default. */
export function fakeTaskTab(t: TestContext): void {
  t.mock.method(currentChrome, "openTaskTab", async (chrome: Pick<currentChrome.CurrentChrome, "cdp">) => {
    const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 5000);
    return { targetId, background: true };
  });
}
