"use strict";

const fs = require("node:fs");
const { registerHooks } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

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

function packageName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("node:") || path.isAbsolute(specifier)) return "";
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Names that some staged package lists under optionalDependencies.
function optionalNames(modules, names = new Set()) {
  if (!fs.existsSync(modules)) return names;
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    const scope = path.join(modules, entry);
    const dirs = entry.startsWith("@") ? fs.readdirSync(scope).map((name) => path.join(scope, name)) : [scope];
    for (const dir of dirs) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest)) {
        const { optionalDependencies } = JSON.parse(fs.readFileSync(manifest, "utf8"));
        for (const name of Object.keys(optionalDependencies || {})) names.add(name);
      }
      optionalNames(path.join(dir, "node_modules"), names);
    }
  }
  return names;
}

// In the installed app an optional module that is not staged fails to load.
// Make it fail here too, even when NODE_PATH or a node_modules above the copy has it.
function hideUnstaged(optional, roots, missing) {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const name = packageName(specifier);
      if (!optional.has(name) || !resolved.url.startsWith("file:")) return resolved;
      if (!outside(fileURLToPath(resolved.url), roots)) return resolved;
      missing.add(name);
      const err = new Error(`Cannot find module '${specifier}': it is optional and not in the staged copy`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    },
  });
}

function assertStaged(cwd) {
  const dir = path.resolve(cwd);
  const modulesRoot = path.join(realpath(dir), "node_modules");
  const roots = allowedRoots(dir);
  const missing = new Set();
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
  const hooks = hideUnstaged(optionalNames(modulesRoot), roots, missing);
  try {
    require(path.join(dir, "src/app/server.js"));
    for (const name of PACKAGES) require(require.resolve(name, { paths: [dir] }));
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    hooks.deregister();
  }
  for (const id of Object.keys(require.cache)) {
    if (before.has(id) || !path.isAbsolute(id)) continue;
    if (outside(id, roots)) {
      return { ok: false, reason: `resolved file is outside the staged copy: ${realpath(id)}` };
    }
  }
  return { ok: true, reason: "", missing: [...missing].sort() };
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
  for (const name of verdict.missing) {
    process.stdout.write(`require-staged: optional ${name} is not staged; the app loads without it\n`);
  }
}

if (require.main === module) main();

module.exports = { assertStaged, PACKAGES };
