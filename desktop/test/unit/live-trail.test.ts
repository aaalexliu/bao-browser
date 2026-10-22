import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_SOURCE, scrubTrailText, typeTrailEvent } from "../../src/mcp/live";

const secret = "SuperSecretPassword!";

test("a live type into a password field omits the secret and names the source", () => {
  const event = typeTrailEvent(secret, {
    surface: "dom",
    role: "password",
    id: "password",
    path: [],
  }, [secret]);
  assert.equal(event.source?.agent, LIVE_SOURCE.agent);
  assert.equal(event.value, undefined);
  assert.equal(event.sensitive, true);
  assert.equal(JSON.stringify(event).includes(secret), false);
});

test("scrub replaces the public test secret in captured text", () => {
  assert.equal(scrubTrailText(`use ${secret} here`, [secret]), "use [secret] here");
});
