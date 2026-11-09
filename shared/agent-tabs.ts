/** What the Bao extension reports about Bao's own tabs in the owner's Chrome, for the desktop CDP relay. */
export type RelayEvent =
  | { kind: "cdp"; tabId: number; sessionId?: string; method: string; params?: unknown }
  /** A page in a Bao tab opened this tab. */
  | { kind: "opened"; tabId: number; openerTabId: number; targetId: string; url: string; title: string }
  | { kind: "info"; tabId: number; url: string; title: string }
  /** Closed, or the owner took it: he pinned it or moved it out of the group. */
  | { kind: "removed"; tabId: number }
  /** The owner pressed Cancel on Chrome's debugging bar. */
  | { kind: "detached"; tabId: number; reason: string };
