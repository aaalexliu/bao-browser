import assert from "node:assert/strict";
import test from "node:test";
import { syncPanel } from "../../src/app/logins-view";
import {
  assertInviteSecret,
  assertOwnerSignIn,
  assertProductionAuth,
  deviceSyncAllowed,
  magicLinkVisible,
  OwnerAuthError,
} from "../../../web/src/lib/owner";

const owner = {
  NODE_ENV: "production",
  BAO_OWNER_EMAIL: "Alex@Example.com",
  BAO_INVITE_SECRET: "generated-secret",
};

test("the wrong email is rejected", () => {
  assert.throws(
    () => assertOwnerSignIn("other@example.com", "generated-secret", owner),
    (err: unknown) => err instanceof OwnerAuthError && err.status === 403 && /owner email/.test(err.message),
  );
});

test("a missing or wrong invite secret is rejected", () => {
  for (const secret of [undefined, "", "   ", "not-the-secret"]) {
    assert.throws(
      () => assertOwnerSignIn("alex@example.com", secret, owner),
      (err: unknown) => err instanceof OwnerAuthError && err.status === 403 && /invite secret/.test(err.message),
    );
    assert.throws(
      () => assertInviteSecret(secret, owner),
      (err: unknown) => err instanceof OwnerAuthError && err.status === 403 && /invite secret/.test(err.message),
    );
  }
  assert.equal(assertOwnerSignIn("alex@example.com", "generated-secret", owner), true);
  assert.doesNotThrow(() => assertInviteSecret("  generated-secret  ", owner));
});

test("owner mode stays off unless both variables are set", () => {
  assert.equal(assertOwnerSignIn("anyone@bao.local", undefined, { NODE_ENV: "development", BAO_AUTH_STUB: "1" }), false);
  assert.throws(
    () => assertOwnerSignIn("alex@example.com", "generated-secret", { BAO_OWNER_EMAIL: "alex@example.com" }),
    /BAO_OWNER_EMAIL and BAO_INVITE_SECRET/,
  );
});

test("production refuses to start when BAO_AUTH_STUB is set", async () => {
  assert.throws(
    () => assertProductionAuth({ NODE_ENV: "production", BAO_AUTH_STUB: "1" }),
    (err: unknown) => err instanceof OwnerAuthError && err.status === 500 && /BAO_AUTH_STUB is refused in production/.test(err.message),
  );
  assert.throws(
    () => assertProductionAuth({
      NODE_ENV: "production",
      BAO_AUTH_STUB: "true",
      BAO_OWNER_EMAIL: "alex@example.com",
      BAO_INVITE_SECRET: "generated-secret",
    }),
    /BAO_AUTH_STUB is refused in production/,
  );
  assert.equal(magicLinkVisible({ NODE_ENV: "production", BAO_AUTH_STUB: "1" }, true), false);
  assert.doesNotThrow(() => assertProductionAuth({ NODE_ENV: "development", BAO_AUTH_STUB: "1" }));
  assert.doesNotThrow(() => assertProductionAuth({
    NODE_ENV: "production",
    BAO_OWNER_EMAIL: "alex@example.com",
    BAO_INVITE_SECRET: "generated-secret",
  }));
  assert.equal(magicLinkVisible({ NODE_ENV: "production" }, true), true);
  assert.equal(magicLinkVisible({ NODE_ENV: "production" }, false), false);
  assert.equal(magicLinkVisible({ NODE_ENV: "development", BAO_AUTH_STUB: "1" }, false), true);

  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    BAO_AUTH_STUB: process.env.BAO_AUTH_STUB,
    NEXT_RUNTIME: process.env.NEXT_RUNTIME,
    BAO_OWNER_EMAIL: process.env.BAO_OWNER_EMAIL,
    BAO_INVITE_SECRET: process.env.BAO_INVITE_SECRET,
  };
  process.env.NODE_ENV = "production";
  process.env.BAO_AUTH_STUB = "1";
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.BAO_OWNER_EMAIL;
  delete process.env.BAO_INVITE_SECRET;
  try {
    const { register } = await import("../../../web/src/instrumentation");
    await assert.rejects(register(), /BAO_AUTH_STUB is refused in production/);
  } finally {
    restore("NODE_ENV", prev.NODE_ENV);
    restore("BAO_AUTH_STUB", prev.BAO_AUTH_STUB);
    restore("NEXT_RUNTIME", prev.NEXT_RUNTIME);
    restore("BAO_OWNER_EMAIL", prev.BAO_OWNER_EMAIL);
    restore("BAO_INVITE_SECRET", prev.BAO_INVITE_SECRET);
  }
});

test("standard deployment protection leaves device sync on the production domain", () => {
  assert.equal(deviceSyncAllowed("standard", "production-domain"), true);
  assert.equal(deviceSyncAllowed("standard", "preview"), false);
  assert.equal(deviceSyncAllowed("standard", "deployment-url"), false);
  assert.equal(deviceSyncAllowed("all", "production-domain"), false);
  assert.equal(deviceSyncAllowed("all", "deployment-url"), false);
  assert.equal(deviceSyncAllowed("off", "preview"), true);
});

test("the sync panel accepts the invite secret once and does not render it", () => {
  const html = syncPanel({ inviteSaved: true, server: "https://bao.example" });
  assert.match(html, /id="invite-secret"/);
  assert.match(html, /Saved on this Mac/);
  assert.doesNotMatch(html, /id="invite-secret"[^>]*value=/);
  assert.equal(html.includes("generated-secret"), false);
});

function restore(key: "NODE_ENV" | "BAO_AUTH_STUB" | "NEXT_RUNTIME" | "BAO_OWNER_EMAIL" | "BAO_INVITE_SECRET", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
