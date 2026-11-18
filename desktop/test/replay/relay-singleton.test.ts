// Next ships the relay twice, once for the upgrade hook and once for /mcp.
// Two copies of this module have to return one object.

import assert from "node:assert/strict";
import { copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

test("two relay bundles share the registry singleton", () => {
  const require = createRequire(__filename);
  const relayJs = path.join(__dirname, "../../../web/src/lib/relay.js");
  const second = path.join(path.dirname(relayJs), "relay-second.js");
  copyFileSync(relayJs, second);
  const slot = globalThis as { baoRelay?: object; baoRelayBoot?: () => Promise<void> };
  delete slot.baoRelay;
  delete slot.baoRelayBoot;
  try {
    const first = require(relayJs) as { registryRelay: () => object };
    const other = require(second) as { registryRelay: () => object };
    const relay = first.registryRelay();
    assert.equal(other.registryRelay(), relay);
    assert.equal(slot.baoRelay, relay);
  } finally {
    rmSync(second, { force: true });
  }
});
