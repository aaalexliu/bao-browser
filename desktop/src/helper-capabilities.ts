import { HELPER_SHOT_COMMAND, LIVE_CHROME_SHOT_ERROR, MacOsHelper } from "./proxy/os-macos";

export type HelperGrant = "accessibility" | "screen-recording";

export interface Capability {
  id: "ax-press" | "window-capture" | "live-chrome" | "mcp-ax";
  ready: string;
  blocked: string;
  grants: readonly HelperGrant[];
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "ax-press",
    ready: "AX press ready",
    blocked: "AX press needs Accessibility",
    grants: ["accessibility"],
  },
  {
    id: "window-capture",
    ready: "window capture ready",
    blocked: "window capture needs Screen Recording",
    grants: ["screen-recording"],
  },
  {
    id: "live-chrome",
    ready: "live Chrome ready",
    blocked: "live Chrome needs Accessibility",
    grants: ["accessibility"],
  },
  {
    id: "mcp-ax",
    ready: "MCP driver ready",
    blocked: "MCP driver needs Accessibility and Screen Recording",
    grants: ["accessibility", "screen-recording"],
  },
];

export interface HelperStatus {
  label: string;
  platform: string;
  accessibility: boolean;
  screenCapture: boolean;
  capabilities: { id: Capability["id"]; status: string }[];
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
    label: accessibility && screenCapture ? "helper ok" : "helper needs permission",
    platform,
    accessibility,
    screenCapture,
    capabilities: CAPABILITIES.map((cap) => ({
      id: cap.id,
      status: cap.grants.every((grant) => held[grant]) ? cap.ready : cap.blocked,
    })),
  };
}

export function liveChromeBlock(perms: {
  prompted?: boolean;
  accessibility?: boolean;
  screenCapture?: boolean;
}): string | undefined {
  if (perms.prompted) return "helper asked for a permission prompt";
  const live = CAPABILITIES.find((cap) => cap.id === "live-chrome");
  if (live?.grants.includes("accessibility") && perms.accessibility !== true) {
    return "BaoOSHelper accessibility is not granted";
  }
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
