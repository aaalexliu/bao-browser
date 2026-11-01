import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLiveHost } from "../../src/cdp-live/live-host";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";
import { fakeChromeHelper } from "../fake-helper";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, type InstacartFixture } from "../instacart/fixture";

interface Body {
  outcome: { kind: string; reason?: string };
  view: { controls: { label: string; ref: string }[] };
}

function ref(body: Body, label: string): string {
  const found = body.view.controls.find((control) => control.label === label);
  assert.ok(found, `${label}: ${JSON.stringify(body.view.controls)}`);
  return found.ref;
}

const CART = "View Cart. Items in cart: 0";

describe("covered clicks in a live session", { timeout: 120_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
  });

  after(async () => {
    await browser?.close();
    await fixture?.close();
  });

  for (const ending of ["stop", "disconnect", "idle", "unresolved", "unrelated-refusal"] as const) {
    it(`${ending}: only retrying the covered control clears its refusal`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-covered-"));
      const host = createLiveHost({
        home,
        lockFile: path.join(home, "lock"),
        target: { kind: "throwaway", portFile: browser.portFile },
        helper: () => fakeChromeHelper().helper,
        openProfile: async () => { throw new Error("not a daily profile"); },
        idleMs: ending === "idle" ? 500 : 0,
        idleWarnMs: 0,
      });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      try {
        const started = await call({ op: "live_session_start", intent: "view the cart", url: fixture.url("/store/costco/storefront"), client: "test" });
        assert.equal(started.outcome.kind, "applied");
        const opened = await call({ op: "live_click", ref: ref(started, CART) });
        assert.equal(opened.outcome.kind, "applied");
        const covered = await call({ op: "live_click", ref: ref(opened, CART) });
        assert.deepEqual(covered.outcome, { kind: "refused", reason: "element is covered" });
        const read = await call({ op: "live_snapshot" });
        const dismissed = await call({ op: "live_click", ref: ref(read, "Close") });
        assert.equal(dismissed.outcome.kind, "applied");
        if (ending !== "unresolved") {
          if (ending === "unrelated-refusal") {
            const stale = await call({ op: "live_click", ref: ref(opened, CART) });
            assert.deepEqual(stale.outcome, { kind: "refused", reason: "stale_ref" });
          }
          const retry = await call({ op: "live_click", ref: ref(dismissed, CART) });
          assert.equal(retry.outcome.kind, "applied");
        }
        if (ending === "idle") {
          const deadline = Date.now() + 10_000;
          while (host.isOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(host.isOpen(), false);
        } else {
          const stopped = await call(ending === "disconnect" ? { op: "live_disconnect", client: "test" } : { op: "live_stop" });
          assert.equal(stopped.outcome.kind, "stopped");
        }
        const saved = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as LiveSessionRecord;
        const failed = ending === "unresolved" || ending === "unrelated-refusal";
        assert.equal(saved.status, failed ? "failed" : "passed");
        assert.equal(saved.note, failed ? "Refused." : ending === "idle" ? "Saved after the agent went quiet." : ending === "disconnect" ? "Saved when the agent disconnected." : "Stopped.");
        assert.deepEqual(fixture.state().traps, []);
        assert.deepEqual(fixture.state().writes, []);
      } finally {
        await host.close();
      }
    });
  }
});
