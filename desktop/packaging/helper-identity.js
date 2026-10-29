"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

const BUNDLE_ID = "dev.bao.oshelper";
const PINNED_CERT_HASH = "a522e15d431a2f36ace451dd575a02e9e877fbd1";

function normalizeCertHash(raw) {
  const hex = String(raw || "").replace(/:/g, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) return "";
  return hex;
}

function helperCertHash(env = process.env) {
  const raw = env.BAO_HELPER_CERT_HASH;
  if (raw == null || raw === "") return PINNED_CERT_HASH;
  return normalizeCertHash(raw);
}

function expectedRequirement(certHash) {
  return `identifier "${BUNDLE_ID}" and certificate leaf = H"${certHash}"`;
}

function acceptHelper(report, identity, certHash) {
  if (!report.exists) return { ok: false, reason: "helper is absent" };
  if (!report.isBundle) return { ok: false, reason: "helper must be the signed BaoOSHelper.app bundle" };
  if (report.adhoc) return { ok: false, reason: "helper signature is ad-hoc" };
  if (report.identifier !== BUNDLE_ID) return { ok: false, reason: "helper bundle id is not dev.bao.oshelper" };
  const leaf = report.authorities[0] || "";
  if (leaf !== identity) return { ok: false, reason: `helper certificate is not ${identity}` };
  const hash = normalizeCertHash(certHash);
  if (!hash) return { ok: false, reason: "helper certificate hash is not 40 hex digits" };
  if (report.designated !== expectedRequirement(hash)) {
    return { ok: false, reason: "designated requirement is not the pinned helper certificate" };
  }
  return { ok: true, reason: "" };
}

function parseCodesign(verifyText, requirementText) {
  const identifier = (verifyText.match(/^Identifier=(.*)$/m) || [])[1] || "";
  const authorities = [...verifyText.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim());
  const adhoc = /^Signature=adhoc$/m.test(verifyText);
  const cdhash = ((verifyText.match(/^CDHash=(.*)$/m) || [])[1] || "").trim();
  const designated = ((requirementText.match(/designated => (.*)$/m) || [])[1] || "").trim();
  return { identifier: identifier.trim(), authorities, adhoc, cdhash, designated };
}

function readBundle(app) {
  const exe = path.join(app, "Contents", "MacOS", "BaoOSHelper");
  let exists = false;
  let isBundle = false;
  try {
    exists = existsSync(app);
    isBundle = exists && statSync(app).isDirectory() && existsSync(exe);
  } catch {
    exists = false;
    isBundle = false;
  }
  return { exists, isBundle };
}

function main() {
  const app = process.argv[2];
  const identity = process.env.BAO_SIGN_IDENTITY || "bao dev signing";
  const certHash = helperCertHash();
  if (!certHash) {
    process.stderr.write("package-app.sh: BAO_HELPER_CERT_HASH must be 40 hex digits\n");
    process.exit(1);
  }
  if (!app) {
    process.stderr.write("usage: helper-identity.js <BaoOSHelper.app>\n");
    process.exit(2);
  }
  const bundle = readBundle(app);
  if (!bundle.exists) {
    process.stderr.write(`package-app.sh: helper is absent (${app}). On a fresh Mac, run desktop/os-helper-macos/package-app.sh. On a rebuild, put the signed helper at that path.\n`);
    process.exit(1);
  }
  if (!bundle.isBundle) {
    process.stderr.write("package-app.sh: helper must be the signed BaoOSHelper.app bundle, not a raw executable.\n");
    process.exit(1);
  }
  const verified = spawnSync("codesign", ["--verify", "--strict", "--verbose=2", app], { encoding: "utf8" });
  const listed = spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" });
  const requirement = spawnSync("codesign", ["-d", "-r-", app], { encoding: "utf8" });
  if (verified.error || listed.error || requirement.error) {
    process.stderr.write("package-app.sh: codesign is required to check the helper.\n");
    process.exit(1);
  }
  if (verified.status !== 0) {
    process.stderr.write(`package-app.sh: helper signature did not verify\n${verified.stdout || ""}${verified.stderr || ""}`);
    process.exit(1);
  }
  const parsed = parseCodesign(`${listed.stdout}\n${listed.stderr}`, `${requirement.stdout}\n${requirement.stderr}`);
  const verdict = acceptHelper({ ...bundle, ...parsed }, identity, certHash);
  if (!verdict.ok) {
    process.stderr.write(`package-app.sh: ${verdict.reason}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  acceptHelper,
  parseCodesign,
  readBundle,
  helperCertHash,
  expectedRequirement,
  BUNDLE_ID,
  PINNED_CERT_HASH,
};
