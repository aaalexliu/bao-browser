import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { artifactsDir } from "../../src/proxy/spike-macos-host";

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("artifactsDir rejects a relative path, a tilde, and dot segments", () => {
  const message = /absolute path|must not contain \.\./;
  withEnv({ BAO_SPIKE_ARTIFACTS: "relative/dir", BAO_AGENT_STORE_DIR: undefined }, () => {
    assert.throws(artifactsDir, message);
  });
  withEnv({ BAO_SPIKE_ARTIFACTS: "~/x", BAO_AGENT_STORE_DIR: undefined }, () => {
    assert.throws(artifactsDir, /absolute path/);
  });
  withEnv({ BAO_SPIKE_ARTIFACTS: ".", BAO_AGENT_STORE_DIR: undefined }, () => {
    assert.throws(artifactsDir, /absolute path/);
  });
  withEnv({ BAO_SPIKE_ARTIFACTS: "/tmp/a/../b", BAO_AGENT_STORE_DIR: undefined }, () => {
    assert.throws(artifactsDir, /must not contain \.\./);
  });
});

test("artifactsDir rejects a store root with fewer than two components", () => {
  for (const store of ["/", "//", "/.", "/Users", "/tmp"]) {
    withEnv({ BAO_SPIKE_ARTIFACTS: undefined, BAO_AGENT_STORE_DIR: store }, () => {
      assert.throws(artifactsDir, /two path components/, store);
    });
  }
});

test("artifactsDir keeps an absolute store and lets the explicit path win", () => {
  const store = path.join(path.sep, "var", "bao-agent-store");
  withEnv({ BAO_SPIKE_ARTIFACTS: undefined, BAO_AGENT_STORE_DIR: store }, () => {
    assert.equal(artifactsDir(), path.join(store, "bao-mac-spike"));
  });
  withEnv({ BAO_SPIKE_ARTIFACTS: "/var/bao-explicit/out", BAO_AGENT_STORE_DIR: store }, () => {
    assert.equal(artifactsDir(), "/var/bao-explicit/out");
  });
  withEnv({ BAO_SPIKE_ARTIFACTS: "/var/./bao-explicit/out", BAO_AGENT_STORE_DIR: undefined }, () => {
    assert.equal(artifactsDir(), "/var/bao-explicit/out");
  });
});
