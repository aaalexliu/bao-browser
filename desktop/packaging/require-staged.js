"use strict";

const path = require("path");

const PACKAGES = ["playwright", "classic-level"];

function assertStaged(cwd) {
  const dir = path.resolve(cwd);
  const root = path.join(dir, "node_modules") + path.sep;
  for (const name of PACKAGES) {
    let resolved;
    try {
      resolved = require.resolve(name, { paths: [dir] });
    } catch (err) {
      return { ok: false, reason: `${name} is missing from the staged copy (${err.message})` };
    }
    if (!resolved.startsWith(root)) {
      return { ok: false, reason: `${name} resolved outside the staged copy: ${resolved}` };
    }
  }
  require(path.join(dir, "src/app/server.js"));
  for (const name of PACKAGES) require(require.resolve(name, { paths: [dir] }));
  return { ok: true, reason: "" };
}

function main() {
  const cwd = process.argv[2];
  if (!cwd) {
    process.stderr.write("usage: require-staged.js DEST_BAO\n");
    process.exit(2);
  }
  const verdict = assertStaged(cwd);
  if (!verdict.ok) {
    process.stderr.write(`package-app.sh: ${verdict.reason}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { assertStaged, PACKAGES };
