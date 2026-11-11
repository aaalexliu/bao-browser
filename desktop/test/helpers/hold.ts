import type { Server } from "node:net";
import type { TestContext } from "node:test";

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

export function holdServer(t: TestContext, server: Server): void {
  t.after(() => closeServer(server));
}

export function holdBrowser(t: TestContext, browser: { close(): Promise<unknown> }): void {
  t.after(() => browser.close().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/has been closed|Target closed|Browser closed/i.test(message)) throw error;
  }));
}
