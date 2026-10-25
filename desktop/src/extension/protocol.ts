// Shared by the desktop bridge and the extension. No Node and no DOM.

export const NATIVE_HOST_NAME = "com.bao.desktop";

/** Unpacked extension id. Derived from EXTENSION_KEY. The private key is not in the repo. */
export const EXTENSION_ID = "jcjcpblcjaakcmbgljdjkfgmmdfdbnfj";

/** Chrome `key` field: SPKI of the extension's public key, base64. */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAl0H8UK1nHYkBdWXEzlOf9IAhS1zt8utMOJEwW5rgD1HLVLR80LBc1lnx31Tpp8m4wGiCoFCFLO+xZtr7C+IdugLaeHQysvxhwgbYFynFZmESI09enBW3oULHQZzQJYCPahZTCx3vwTPbOe6tZT7O0t232BrZnc/FavjODlNvehrE6GNk2oAEbylRHZXyVxCTA6NuOJ6L6Z1C4P0ZIQlrF9rUxqOYYS8igdxmIHsTb0P2NkrDcr5ZYkr353SRfQqfPqd4o8E9OD2eyMTbGIstmF5FH9oKLvv15uxXsACVVsyrL+yGA7XtDv+HkcCG0sp8cmWGlJoq3vBh8GsHZaoFHwIDAQAB";

export type DriverName = "playwright" | "extension";

/** Absent, or anything other than extension, stays on Playwright. Old workflows keep their driver. */
export function workflowDriver(doc: { driver?: string | null }): DriverName {
  return doc.driver === "extension" ? "extension" : "playwright";
}

/** Pointer samples are offsets from the start of this gesture, taken from the recording. */
export interface Gesture {
  dwellMs: number;
  pointer: { dt: number; x: number; y: number }[];
  keyGaps: number[];
  /** Set by the driver when BAO_GESTURE_MAX_MS is present. Absent means the recording's own times. */
  maxMs?: number;
}

export interface HelloMessage {
  type: "hello";
  extensionId: string;
  version: string;
  resumed?: boolean;
}

export function extensionOrigin(id = EXTENSION_ID): string {
  return `chrome-extension://${id}/`;
}
