import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_SOURCE, typeTrailEvent } from "../../src/mcp/live";
import { STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import { keyTrailIdentity } from "../../src/cdp-live/live-trail";

const secret = "SuperSecretPassword!";

test("a live type into a password field strips the whole value and names the source", () => {
  const event = typeTrailEvent(secret, {
    surface: "dom",
    role: "password",
    id: "password",
    path: [],
  }, [secret]);
  assert.equal(event.source?.agent, LIVE_SOURCE.agent);
  assert.equal(event.value, STRIPPED_SECRET);
  assert.equal(event.sensitive, true);
  assert.equal(JSON.stringify(event).includes(secret), false);
});

test("key identities keep stable locators and discard all editable text representations", () => {
  for (const tag of ["input", "textarea", "div"]) {
    const identity = keyTrailIdentity({ surface: "dom", role: "textbox", tag, id: "field", testId: "stable-field", cssPath: "#field", xpath: '//*[@id="field"]', nameAttr: "entry", value: "654321", text: "654321", name: "654321", label: "654321", title: "654321", description: "654321", path: [{ role: "form", name: "654321" }] })!;
    assert.equal(identity.id, "field");
    assert.equal(identity.testId, "stable-field");
    assert.equal(identity.cssPath, "#field");
    assert.equal(identity.xpath, '//*[@id="field"]');
    assert.deepEqual(identity.path, [{ role: "form" }]);
    assert.equal(JSON.stringify(identity).includes("654321"), false);
  }
  assert.equal(keyTrailIdentity(undefined), undefined);
});

test("live type capture preserves embedded free text and template metadata", () => {
  const text = `use ${secret} here`;
  const identity = { surface: "dom" as const, role: "textbox", id: "password", name: "Type {{password}}", path: [] };
  const event = typeTrailEvent(text, identity, [secret, "pass", "secret"]);
  assert.equal(event.value, text);
  assert.deepEqual(event.identity, identity);
});
