"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

const BUNDLE_ID = "dev.bao.oshelper";
const PINNED_CERT_HASH = "a522e15d431a2f36ace451dd575a02e9e877fbd1";
/** codesign's selector for an ad-hoc signature. A release built without a signing secret uses it. */
const ADHOC = "-";

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

const TEAM_ID = /^[A-Z0-9]{10}$/;

function expectedRequirement(certHash) {
  return `identifier "${BUNDLE_ID}" and certificate leaf = H"${certHash}"`;
}

/** Apple's designated requirement for a Developer ID Application certificate. The team id is not quoted. */
function appleTeamRequirement(teamId) {
  return `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${teamId}`;
}

function requirementMatchesTeam(designated, teamId) {
  const bare = appleTeamRequirement(teamId);
  return designated === bare || designated === bare.replace(`= ${teamId}`, `= "${teamId}"`);
}

function teamFromSubject(subject) {
  const ou = String(subject || "").match(/(?:^|[,/\s])OU=([A-Z0-9]{10})(?:[,/\s]|$)/);
  if (ou) return ou[1];
  const paren = String(subject || "").match(/\(([A-Z0-9]{10})\)/);
  return paren ? paren[1] : "";
}

/**
 * How ci-signing.sh records a release identity.
 * A Developer ID certificate is not pinned to its leaf SHA-1: renewal keeps the team id.
 * A self-signed project certificate still pins the leaf hash, which is the requirement codesign writes for it.
 */
function signingPlan(subject, issuer, teamId) {
  const text = `${subject || ""}\n${issuer || ""}`;
  const developerId = /Developer ID Application/.test(text) || /Developer ID Certification Authority/.test(issuer || "");
  const team = String(teamId || "").trim();
  if (!developerId) {
    if (team) return { ok: false, pinHash: false, teamId: "", reason: "BAO_APPLE_TEAM_ID is set but the certificate is not Developer ID" };
    return { ok: true, pinHash: true, teamId: "", reason: "" };
  }
  if (!TEAM_ID.test(team)) return { ok: false, pinHash: false, teamId: "", reason: "Developer ID certificate needs BAO_APPLE_TEAM_ID (10 letters or digits)" };
  const fromCert = teamFromSubject(subject);
  if (fromCert && fromCert !== team) return { ok: false, pinHash: false, teamId: "", reason: `BAO_APPLE_TEAM_ID ${team} does not match the certificate team ${fromCert}` };
  return { ok: true, pinHash: false, teamId: team, reason: "" };
}

function acceptHelper(report, identity, certHash, teamId) {
  if (!report.exists) return { ok: false, reason: "helper is absent" };
  if (!report.isBundle) return { ok: false, reason: "helper must be the signed BaoOSHelper.app bundle" };
  const team = String(teamId || "").trim();
  // An ad-hoc build signs everything ad-hoc. macOS then keys Bao's grant to one build, so
  // Device Control and Data Access does not survive an update. Running Chrome uses that grant.
  if (identity === ADHOC) {
    if (team) return { ok: false, reason: "BAO_APPLE_TEAM_ID is set, so this is not an ad-hoc build" };
    if (!report.adhoc) return { ok: false, reason: "an ad-hoc build (BAO_SIGN_IDENTITY=-) needs an ad-hoc helper" };
    if (report.identifier !== BUNDLE_ID) return { ok: false, reason: "helper bundle id is not dev.bao.oshelper" };
    return { ok: true, reason: "" };
  }
  if (report.adhoc) return { ok: false, reason: "helper signature is ad-hoc" };
  if (report.identifier !== BUNDLE_ID) return { ok: false, reason: "helper bundle id is not dev.bao.oshelper" };
  if (team) {
    if (!TEAM_ID.test(team)) return { ok: false, reason: "BAO_APPLE_TEAM_ID must be 10 letters or digits" };
    if (!requirementMatchesTeam(report.designated, team)) {
      return { ok: false, reason: "designated requirement is not Apple's Developer ID form for this team" };
    }
    const identityHash = normalizeCertHash(identity);
    const leaf = report.authorities[0] || "";
    if (!identityHash && leaf !== identity) return { ok: false, reason: `helper certificate is not ${identity}` };
    return { ok: true, reason: "" };
  }
  const hash = normalizeCertHash(certHash);
  if (!hash) return { ok: false, reason: "helper certificate hash is not 40 hex digits" };
  const identityHash = normalizeCertHash(identity);
  const leaf = report.authorities[0] || "";
  if (identityHash ? identityHash !== hash : leaf !== identity) {
    return { ok: false, reason: `helper certificate is not ${identity}` };
  }
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
  const teamId = String(process.env.BAO_APPLE_TEAM_ID || "").trim();
  const certHash = helperCertHash();
  if (teamId && !TEAM_ID.test(teamId)) {
    process.stderr.write("package-app.sh: BAO_APPLE_TEAM_ID must be 10 letters or digits\n");
    process.exit(1);
  }
  if (!teamId && !certHash) {
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
  const verdict = acceptHelper({ ...bundle, ...parsed }, identity, certHash, teamId);
  if (!verdict.ok) {
    process.stderr.write(`package-app.sh: ${verdict.reason}\n`);
    process.exit(1);
  }
  if (identity === ADHOC) process.stderr.write("package-app.sh: ad-hoc build. macOS will not keep Bao's Device Control and Data Access grant across updates.\n");
}

if (require.main === module) main();

module.exports = {
  acceptHelper,
  parseCodesign,
  readBundle,
  helperCertHash,
  expectedRequirement,
  appleTeamRequirement,
  signingPlan,
  ADHOC,
  BUNDLE_ID,
  PINNED_CERT_HASH,
};
