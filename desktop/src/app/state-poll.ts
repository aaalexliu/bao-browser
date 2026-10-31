import type { ShellState } from "./views";
import type { LiveSessionRecord } from "../cdp-live/live-record";

type PollState = ShellState & { liveSession?: Pick<LiveSessionRecord, "status"> | null };

export function activePolling(state: PollState): boolean {
  return Boolean(
    state.recording || state.replaying || state.activeAsk ||
    state.teach?.phase === "live" || state.guide?.status === "highlight" ||
    state.liveSession?.status === "running" || state.remote?.phase === "running" || state.remote?.phase === "confirm" ||
    state.pendingImport?.phase === "running",
  );
}

export function createStatePoller(options: {
  poll(): Promise<void>;
  active(): boolean;
  visible(): boolean;
}): { refresh(): Promise<void>; visibilityChanged(): void; track<T>(request: Promise<T>): Promise<T> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  let retryMs = 0;
  let activeRequests = 0;

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    if (queued) return;
    const delay = retryMs || (activeRequests || options.active() ? 100 : 1000);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(() => undefined);
    }, options.visible() ? delay : Math.max(delay, 5000));
  }

  function refresh(): Promise<void> {
    if (pending) {
      queued ??= pending.catch(() => undefined).then(() => {
        queued = undefined;
        return refresh();
      });
      return queued;
    }
    clearTimer();
    pending = Promise.resolve().then(options.poll).then(
      () => { retryMs = 0; },
      (error: unknown) => {
        retryMs = Math.min(retryMs ? retryMs * 2 : 500, 10000);
        throw error;
      },
    ).finally(() => {
      pending = undefined;
      schedule();
    });
    return pending;
  }

  return {
    refresh,
    visibilityChanged(): void {
      clearTimer();
      if (options.visible()) void refresh().catch(() => undefined);
      else if (!pending) schedule();
    },
    async track<T>(request: Promise<T>): Promise<T> {
      activeRequests += 1;
      void refresh().catch(() => undefined);
      try {
        return await request;
      } finally {
        activeRequests -= 1;
        void refresh().catch(() => undefined);
      }
    },
  };
}
