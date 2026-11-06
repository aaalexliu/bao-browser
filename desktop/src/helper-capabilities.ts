import { HELPER_SHOT_COMMAND, LIVE_CHROME_SHOT_ERROR, MacOsHelper } from "./proxy/os-macos";

export type HelperGrant = "accessibility" | "screen-recording";

export interface Capability {
  id: "window-capture" | "mcp-ax";
  ready: string;
  blocked: string;
  grants: readonly HelperGrant[];
  optional: true;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "window-capture",
    ready: "window capture ready",
    blocked: "optional window capture needs Screen Recording (not needed for Chrome)",
    grants: ["screen-recording"],
    optional: true,
  },
  {
    id: "mcp-ax",
    ready: "MCP driver ready",
    blocked: "optional native-app MCP driver needs Accessibility and Screen Recording (not needed for Chrome)",
    grants: ["accessibility", "screen-recording"],
    optional: true,
  },
];

export interface HelperStatus {
  label: string;
  platform: string;
  accessibility: boolean;
  screenCapture: boolean;
  capabilities: { id: Capability["id"]; status: string; optional: true }[];
}

export function capabilityReport(input: {
  platform: string;
  helperPresent: boolean;
  accessibility?: boolean;
  screenCapture?: boolean;
}): HelperStatus {
  const platform = input.platform;
  if (platform !== "darwin" || !input.helperPresent) {
    return { label: "helper off", platform, accessibility: false, screenCapture: false, capabilities: [] };
  }
  const accessibility = input.accessibility === true;
  const screenCapture = input.screenCapture === true;
  const held: Record<HelperGrant, boolean> = {
    accessibility,
    "screen-recording": screenCapture,
  };
  return {
    label: "helper available",
    platform,
    accessibility,
    screenCapture,
    capabilities: CAPABILITIES.map((cap) => ({
      id: cap.id,
      optional: cap.optional,
      status: cap.grants.every((grant) => held[grant]) ? cap.ready : cap.blocked,
    })),
  };
}

export function remoteDebuggingBlock(perms: {
  prompted?: boolean;
  accessibility?: boolean;
  screenCapture?: boolean;
}): string | undefined {
  if (perms.prompted) return "helper asked for a permission prompt";
  if (perms.accessibility !== true) return "BaoOSHelper accessibility is not granted";
  return undefined;
}

export function usesScreenRecording(calls: readonly (readonly string[])[]): boolean {
  return calls.some((call) => call[0] === HELPER_SHOT_COMMAND);
}

export function forbidScreenRecording(helper: MacOsHelper): MacOsHelper {
  helper.refuseWindowShot = true;
  helper.shot = () => Promise.reject(new Error(LIVE_CHROME_SHOT_ERROR));
  return helper;
}
