import assert from "node:assert/strict";
import test from "node:test";
import { NEEDS_SIGN_IN, runIfSignedIn } from "../../src/login-import/session-gate";

test("a dead session does not start the run", async () => {
  let ran = false;
  let probed = false;
  const dead = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-1",
    probe: async () => {
      probed = true;
      return { signedIn: false };
    },
    run: async () => { ran = true; return "ran"; },
  });
  assert.equal(probed, true);
  assert.equal(ran, false);
  if (typeof dead === "string" || dead.status !== "needs-sign-in") throw new Error("expected needs-sign-in");
  assert.deepEqual(dead.steps, []);
  assert.equal(dead.message, NEEDS_SIGN_IN);
  assert.equal(dead.offerSignIn, true);
  const thrown = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-2",
    probe: async () => { throw new Error("down"); },
    run: async () => { ran = true; return "ran"; },
  });
  if (typeof thrown === "string" || thrown.status !== "needs-sign-in") throw new Error("expected needs-sign-in");
  assert.equal(ran, false);
  const live = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-3",
    probe: async () => ({ signedIn: true }),
    run: async () => "ran",
  });
  assert.equal(live, "ran");
  let gatedProbe = false;
  const skipped = await runIfSignedIn({
    enabled: false,
    signInUrl: "https://example.com/home",
    runId: "run-4",
    probe: async () => { gatedProbe = true; return { signedIn: false }; },
    run: async () => "open",
  });
  assert.equal(gatedProbe, false);
  assert.equal(skipped, "open");
});
