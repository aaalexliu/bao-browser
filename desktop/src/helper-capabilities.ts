/** Mac grants a Bao job can require. Screen Recording is window capture, not live Chrome. */
export type HelperGrant = "accessibility" | "screen-recording";

export interface Capability {
  id: "native-ax" | "window-capture" | "live-chrome" | "extension-replay";
  ready: string;
  blocked: string;
  grant?: HelperGrant;
  usesScreenRecording: boolean;
}

export const WINDOW_CAPTURE_COMMAND = "shot";

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "native-ax",
    ready: "native automation ready",
    blocked: "native automation needs Accessibility",
    grant: "accessibility",
    usesScreenRecording: false,
  },
  {
    id: "window-capture",
    ready: "window capture ready",
    blocked: "window capture needs Screen Recording",
    grant: "screen-recording",
    usesScreenRecording: true,
  },
  {
    id: "live-chrome",
    ready: "live Chrome ready",
    blocked: "live Chrome needs Accessibility",
    grant: "accessibility",
    usesScreenRecording: false,
  },
  {
    id: "extension-replay",
    ready: "extension replay ready",
    blocked: "extension replay ready",
    usesScreenRecording: false,
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
  return {
    label: accessibility && screenCapture ? "helper ok" : "helper needs permission",
    platform,
    accessibility,
    screenCapture,
    capabilities: [],
  };
}

export function liveChromeBlock(perms: {
  prompted?: boolean;
  accessibility?: boolean;
  screenCapture?: boolean;
}): string | undefined {
  if (perms.prompted) return "helper asked for a permission prompt";
  if (perms.accessibility !== true) return "BaoOSHelper accessibility is not granted";
  if (perms.screenCapture) return "BaoOSHelper screen recording is granted; not starting";
  return undefined;
}

export function usesScreenRecording(calls: readonly (readonly string[])[]): boolean {
  return calls.some((call) => call[0] === WINDOW_CAPTURE_COMMAND);
}

export function forbidScreenRecording<T extends { shot(...args: never[]): Promise<unknown> }>(helper: T): T {
  return helper;
}
