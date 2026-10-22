import assert from "node:assert/strict";
import test from "node:test";
import { assertSyncSafe, buildPushBody, SyncRejected } from "../../../web/src/lib/guard";
import { redactForRelease } from "../../../web/src/lib/publish";

test("a secret-tagged param or a cookie is rejected", () => {
  assert.throws(
    () => assertSyncSafe({ inputs: [{ name: "password", type: "secret", value: "SuperSecret" }] }),
    (err: unknown) => err instanceof SyncRejected && /secret/.test(err.message),
  );
  assert.throws(
    () => assertSyncSafe({
      document: { inputs: [{ name: "password", type: "secret" }] },
      args: { password: "SuperSecret" },
    }),
    (err: unknown) => err instanceof SyncRejected && /secret/.test(err.message),
  );
  assert.throws(() => assertSyncSafe({ cookie: "session=abc" }), /cookie/);
  assert.throws(() => assertSyncSafe({ "Set-Cookie": "session=abc" }), /cookie/);
});

test("a push body drops secret values, cookies, and screenshot bytes", () => {
  const secret = "SuperSecret";
  const body = buildPushBody(
    {
      id: "wf",
      inputs: [{ name: "password", type: "secret", default: secret }],
      steps: [{ id: "pass", sensitive: true, value: secret }],
      cookie: "session=abc",
    },
    {
      baseVersion: 1,
      heal: { snapshot: { screenshot: "not-a-real-image", dom: "button" }, note: "kept" },
    },
  );
  const blob = JSON.stringify(body);
  assert.equal(blob.includes(secret), false);
  assert.equal(hasCookieKey(body), false);
  assert.equal(JSON.stringify(body.heal).includes("screenshot"), false);
  assert.equal((body.heal as { snapshot?: { dom?: string } }).snapshot?.dom, "button");
});

test("sharing and publishing clear personal values", () => {
  const { document } = redactForRelease({
    inputs: [
      { name: "password", type: "secret", default: "SuperSecret" },
      { name: "email", type: "text", default: "ada@acme.com" },
      { name: "phone", type: "text", default: "415-555-1212" },
      { name: "ssn", type: "text", default: "123-45-6789" },
      { name: "addr", type: "text", default: "1 Market Street" },
      { name: "card", type: "text", default: "4242424242424242" },
    ],
    steps: [{ label: "Email ada@acme.com today" }],
  });
  const blob = JSON.stringify(document);
  for (const value of ["SuperSecret", "ada@acme.com", "415-555-1212", "123-45-6789", "1 Market Street", "4242424242424242"]) {
    assert.equal(blob.includes(value), false, value);
  }
});

function hasCookieKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCookieKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    /^(cookie|cookies|set-cookie|setcookie)$/i.test(key) || hasCookieKey(child)
  ));
}
