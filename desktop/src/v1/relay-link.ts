// The relay token stays in this file, mode 0600. It is not settings.json and
// it is not returned by /api/state.

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RelayLink {
  server: string;
  token: string;
  deviceId: string;
  tokenId?: string;
}

export function relayPath(root: string): string {
  return path.join(root, "relay.json");
}

export function loadRelay(root: string): RelayLink | null {
  try {
    const parsed = JSON.parse(readFileSync(relayPath(root), "utf8")) as Partial<RelayLink>;
    if (!parsed.server || !parsed.token || !parsed.deviceId) return null;
    return {
      server: String(parsed.server).replace(/\/$/, ""),
      token: parsed.token,
      deviceId: parsed.deviceId,
      tokenId: typeof parsed.tokenId === "string" ? parsed.tokenId : undefined,
    };
  } catch {
    return null;
  }
}

export function saveRelay(root: string, link: RelayLink): void {
  const file = relayPath(root);
  writeFileSync(file, JSON.stringify({
    server: link.server.replace(/\/$/, ""),
    token: link.token,
    deviceId: link.deviceId,
    tokenId: link.tokenId,
  }, null, 2));
  chmodSync(file, 0o600);
}

export function clearRelay(root: string): void {
  rmSync(relayPath(root), { force: true });
}

/** Paired or not. The token is not included. */
export function relayStatus(root: string): { paired: boolean; deviceId?: string } {
  const link = loadRelay(root);
  if (!link) return { paired: false };
  return { paired: true, deviceId: link.deviceId };
}
