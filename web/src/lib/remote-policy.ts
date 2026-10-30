// Server-set rules for a remote run. The Mac checks the same object again
// before it executes anything. A policy that would let the cloud approve a
// confirm is rejected.

export const REMOTE_POLICY = {
  version: 1,
  requireLocalApproval: true,
  confirmLocalOnly: true,
  remoteMayApproveConfirm: false,
} as const;

export type RemotePolicy = typeof REMOTE_POLICY;

export function policyAllowsRemoteRun(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  const row = policy as Record<string, unknown>;
  return row.version === 1
    && row.requireLocalApproval === true
    && row.confirmLocalOnly === true
    && row.remoteMayApproveConfirm === false;
}

/** Stored on the Mac. Absent means ask. The cloud client cannot set this. */
export type DevicePermission = "ask" | "deny";

export function devicePermission(value: unknown): DevicePermission {
  return value === "deny" ? "deny" : "ask";
}
