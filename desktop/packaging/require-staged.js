"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGES = ["playwright", "classic-level"];
const SIBLINGS = ["extension", "src", "web"];

function realpath(file) {
  return fs.realpathSync(file);
}

function isInside(file, root) {
  let real;
  try {
    real = realpath(file);
  } catch {
    return false;
  }
  return real === root || real.startsWith(root + path.sep);
}

function allowedRoots(dir) {
  const bao = realpath(dir);
  const roots = [bao];
  const parent = path.dirname(dir);
  for (const name of SIBLINGS) {
    const sibling = path.join(parent, name);
    if (!fs.existsSync(sibling)) continue;
    roots.push(realpath(sibling));
  }
  return roots;
}

function outside(file, roots) {
  return !roots.some((root) => isInside(file, root));
}

function assertStaged(cwd) {
  const dir = path.resolve(cwd);
  const modulesRoot = path.join(realpath(dir), "node_modules");
  const roots = allowedRoots(dir);
  const before = new Set(Object.keys(require.cache));
  for (const name of PACKAGES) {
    let resolved;
    try {
      resolved = require.resolve(name, { paths: [dir] });
    } catch (err) {
      return { ok: false, reason: `${name} is missing from the staged copy (${err.message})` };
    }
    if (!isInside(resolved, modulesRoot)) {
      return { ok: false, reason: `${name} resolved outside the staged copy: ${realpath(resolved)}` };
    }
  }
  try {
    require(path.join(dir, "src/app/server.js"));
    for (const name of PACKAGES) require(require.resolve(name, { paths: [dir] }));
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  for (const id of Object.keys(require.cache)) {
    if (before.has(id) || !path.isAbsolute(id)) continue;
    if (outside(id, roots)) {
      return { ok: false, reason: `resolved file is outside the staged copy: ${realpath(id)}` };
    }
  }
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
