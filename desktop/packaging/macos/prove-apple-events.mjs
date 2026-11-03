// Usage: node prove-apple-events.mjs path/to/Bao.app
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

assert.ok(process.argv[2], "pass the built Bao.app path");
const plist = path.resolve(process.argv[2], "Contents/Info.plist");
const purpose = JSON.parse(execFileSync("/usr/bin/plutil", [
  "-convert", "json", "-o", "-", plist,
], { encoding: "utf8" })).NSAppleEventsUsageDescription;
assert.equal(typeof purpose, "string", `${plist}: NSAppleEventsUsageDescription must be a string`);
assert.ok(purpose.trim(), `${plist}: NSAppleEventsUsageDescription must not be empty`);
console.log(`APPLE_EVENTS ok ${plist}`);
