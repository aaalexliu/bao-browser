import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Ajv from "ajv/dist/2020";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import { popupDismissName, validateWorkflow, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { createLiveHost } from "../../src/cdp-live/live-host";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";
import { fakeChromeHelper } from "../fake-helper";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, type InstacartFixture } from "../instacart/fixture";

interface Body {
  outcome: { kind: string; reason?: string };
  session?: string;
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

  for (const failure of ["covered", "blocked"] as const) {
    it(`${failure} click keeps its step when the next click is refused`, async (t) => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-click-step-"));
      if (failure === "blocked") {
        const goto = CdpLiveDriver.prototype.goto;
        t.mock.method(CdpLiveDriver.prototype, "goto", async function (this: CdpLiveDriver, url: string) {
          await goto.call(this, url);
          await this.evaluateFunction(() => {
            const browse = document.createElement("button");
            browse.textContent = "Browse";
            browse.onclick = () => { location.href = "/checkout"; };
            document.body.prepend(browse);
          }, undefined);
        });
      }
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target: { kind: "throwaway", portFile: browser.portFile }, idleMs: 0 });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      const session = () => JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as LiveSessionRecord;
      try {
        let read = await call({ op: "live_session_start", intent: "browse the store", url: fixture.url("/store/costco/storefront") });
        assert.equal(read.outcome.kind, "applied");
        if (failure === "covered") {
          read = await call({ op: "live_click", ref: ref(read, CART) });
          assert.equal(read.outcome.kind, "applied");
        }
        const before = session();
        const first = await call({ op: "live_click", ref: ref(read, failure === "covered" ? CART : "Browse") });
        assert.deepEqual(first.outcome, { kind: "refused", reason: failure === "covered" ? "element is covered" : "blocked-path" });
        const afterFirst = session();
        assert.deepEqual(afterFirst.steps.slice(before.steps.length), [{ name: "click", status: "running", ms: 0 }]);
        assert.equal(afterFirst.audit.length, before.audit.length + 1);
        assert.equal(afterFirst.audit.at(-1)?.action, "click");
        const refused = await call({ op: "live_click", ref: "e0.c0" });
        assert.deepEqual(refused.outcome, { kind: "refused", reason: "stale_ref" });
        const afterRefusal = session();
        assert.deepEqual(afterRefusal.steps.slice(before.steps.length), [
          { name: "click", status: "running", ms: 0 },
          { name: "click", status: "failed", ms: 0 },
        ]);
        assert.equal(afterRefusal.audit.length, afterFirst.audit.length + 1);
        assert.deepEqual(afterRefusal.audit.slice(0, afterFirst.audit.length), afterFirst.audit);
        assert.equal(afterRefusal.audit.at(-1)?.label, "stale_ref");
        if (failure === "covered") {
          const applied = await call({ op: "live_click", ref: ref(refused, "Close") });
          assert.equal(applied.outcome.kind, "applied");
          const afterApplied = session();
          assert.equal(afterApplied.steps.length, afterRefusal.steps.length + 1);
          assert.equal(afterApplied.steps.at(-1)?.status, "passed");
          assert.equal(afterApplied.audit.length, afterRefusal.audit.length + 2);
        }
        assert.equal((await call({ op: "live_stop" })).outcome.kind, "stopped");
        assert.equal(session().status, "failed");
      } finally { await host.close(); }
    });
  }

  for (const urlChange of ["hash", "query"] as const) {
    it(`a ${urlChange}-changing popup recovers and its dismiss step replays with or without the popup`, async (t) => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-optional-dismiss-"));
      let popup = true;
      let extraClose = false;
      const unrelatedDismissed: boolean[] = [];
      const end = CdpLiveDriver.prototype.end;
      t.mock.method(CdpLiveDriver.prototype, "end", async function (this: CdpLiveDriver) {
        unrelatedDismissed.push(await this.evaluateFunction<boolean>(() => document.body.dataset.unrelatedClosed === "yes", undefined));
        await end.call(this);
      });
      const goto = CdpLiveDriver.prototype.goto;
      t.mock.method(CdpLiveDriver.prototype, "goto", async function (this: CdpLiveDriver, url: string) {
        await goto.call(this, url);
        if (extraClose) await this.evaluateFunction(() => {
          const cart = document.createElement("div");
          cart.setAttribute("role", "region");
          cart.setAttribute("aria-label", "Cart");
          const close = document.createElement("button");
          close.textContent = "Close";
          close.onclick = () => { document.body.dataset.unrelatedClosed = "yes"; cart.remove(); };
          cart.append(close);
          document.body.append(cart);
        }, undefined);
        if (popup) await this.evaluateFunction((change: string) => {
          const original = location.href;
          history.replaceState(null, "", change === "hash" ? `${original}#welcome` : `${original}?welcome=1`);
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-label", "Welcome");
          dialog.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
          const close = document.createElement("button");
          close.textContent = "Close";
          close.onclick = () => { dialog.remove(); history.replaceState(null, "", original); };
          dialog.append(close);
          document.body.append(dialog);
        }, urlChange);
      });
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target: { kind: "throwaway", portFile: browser.portFile }, idleMs: 0 });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      try {
        const started = await call({ op: "live_session_start", intent: "search Costco after dismissing welcome", url: fixture.url("/store/costco/storefront") });
        assert.equal(started.outcome.kind, "applied");
        const covered = await call({ op: "live_click", ref: ref(started, "Search Costco") });
        assert.deepEqual(covered.outcome, { kind: "refused", reason: "element is covered" });
        const dismissed = await call({ op: "live_click", ref: ref(covered, "Close") });
        assert.equal(dismissed.outcome.kind, "applied");
        const retried = await call({ op: "live_click", ref: ref(dismissed, "Search Costco") });
        assert.equal(retried.outcome.kind, "applied");
        const typed = await call({ op: "live_type", ref: ref(retried, "Search Costco"), text: "blueberries" });
        assert.equal(typed.outcome.kind, "applied");
        assert.equal((await call({ op: "live_stop" })).outcome.kind, "stopped");
        const session = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as LiveSessionRecord;
        assert.equal(session.status, "passed");
        const workflow = new Library(home).read(started.session!);
        const optional = workflow.steps.filter((step) => step.optional);
        assert.equal(optional.length, 1, JSON.stringify({ workflow, trail: readFileSync(path.join(home, "live-session", "trail.jsonl"), "utf8") }));
        assert.equal(popupDismissName(optional[0]?.identity), "Close");
        if (urlChange === "hash") {
          assert.equal(optional[0]?.expect?.kind, "settled");
          assert.equal(optional[0]?.confidence, "low");
        }
        const validate = new Ajv({ strict: false }).compile(JSON.parse(readFileSync("schema/workflow-v2.schema.json", "utf8")) as object);
        assert.deepEqual(validateWorkflow(workflow), []);
        assert.equal(validate(workflow), true, JSON.stringify(validate.errors));
        for (const patch of [{ action: "type" }, { identity: { ...optional[0]!.identity, name: "Accept" } }, { optional: true }]) {
          const invalid = { ...workflow, steps: workflow.steps.map((step) => step.optional ? { ...step, ...patch } : step) } as WorkflowV2;
          assert.ok(validateWorkflow(invalid).some((error) => error.startsWith("optional ")));
          assert.equal(validate(invalid), false);
        }
        extraClose = true;
        for (popup of [true, false]) {
          const run = await host.replay(workflow);
          assert.equal(run.status, "passed", JSON.stringify(run.failure));
          const dismiss = run.steps.find((step) => step.id === optional[0]!.id);
          assert.equal(dismiss?.status, popup ? "passed" : "skipped");
          if (!popup) assert.equal(dismiss?.reason, "optional dismiss absent");
          assert.equal(run.modelCalls, 0);
          assert.equal(unrelatedDismissed.at(-1), false, "the cart's Close must not be clicked");
        }
        extraClose = false;
        const required = { ...workflow, steps: workflow.steps.map((step) => ({ ...step, optional: undefined, timeoutMs: 200 })) };
        const missed = await host.replay(required);
        assert.equal(missed.status, "failed");
        assert.equal(missed.failure?.stepId, optional[0]!.id);
      } finally { await host.close(); }
    });
  }

  for (const stable of ["id", "testId", "nameAttr", "href", "cssPath"] as const) {
    it(`recovers the same control by ${stable} after its ETA and position change`, async (t) => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-covered-identity-"));
      const goto = CdpLiveDriver.prototype.goto;
      t.mock.method(CdpLiveDriver.prototype, "goto", async function (this: CdpLiveDriver, url: string) {
        await goto.call(this, url);
        await this.evaluateFunction((field: string) => {
          const spacer = document.createElement("div");
          const area = document.createElement("div");
          const target = document.createElement(field === "href" ? "a" : "button");
          target.textContent = "Costco By 12:45pm";
          if (field === "id") target.id = "costco-store";
          if (field === "testId") target.setAttribute("data-testid", "costco-store");
          if (field === "nameAttr") target.setAttribute("name", "costco-store");
          if (field === "href") target.setAttribute("href", "/store/costco/storefront");
          target.onclick = (event) => { event.preventDefault(); target.textContent = "Costco ready"; };
          area.append(target);
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.setAttribute("aria-label", "Welcome");
          dialog.style.cssText = "position:fixed;inset:0;z-index:99999;background:white";
          const close = document.createElement("button");
          close.textContent = "Close";
          close.onclick = () => {
            target.textContent = "Costco By 1:00pm";
            if (field !== "cssPath") spacer.remove();
            dialog.remove();
          };
          dialog.append(close);
          document.body.prepend(spacer, area, dialog);
        }, stable);
      });
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target: { kind: "throwaway", portFile: browser.portFile }, idleMs: 0 });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      try {
        const started = await call({ op: "live_session_start", intent: "open Costco after welcome", url: fixture.url("/store/costco/storefront") });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const covered = await call({ op: "live_click", ref: ref(started, "Costco By 12:45pm") });
          assert.deepEqual(covered.outcome, { kind: "refused", reason: "element is covered" });
        }
        const dismissed = await call({ op: "live_click", ref: ref(started, "Close") });
        assert.equal(dismissed.outcome.kind, "applied");
        const retried = await call({ op: "live_click", ref: ref(dismissed, "Costco By 1:00pm") });
        assert.equal(retried.outcome.kind, "applied");
        assert.equal((await call({ op: "live_stop" })).outcome.kind, "stopped");
        const session = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as LiveSessionRecord;
        assert.equal(session.status, "passed");
        const workflow = new Library(home).read(started.session!);
        assert.equal(workflow.steps.filter((step) => step.optional === "dismiss").length, 1);
      } finally { await host.close(); }
    });
  }

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
        const workflow = new Library(home).read(saved.id);
        assert.equal(workflow.steps.filter((step) => step.optional).length, ending === "unresolved" ? 0 : 1);
        assert.equal(saved.note, failed ? "Refused." : ending === "idle" ? "Saved after the agent went quiet." : ending === "disconnect" ? "Saved when the agent disconnected." : "Stopped.");
        assert.deepEqual(fixture.state().traps, []);
        assert.deepEqual(fixture.state().writes, []);
      } finally {
        await host.close();
      }
    });
  }
});
