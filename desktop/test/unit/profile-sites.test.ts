import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChromeProfileQuestion } from "../../src/engines/browser-pick";
import { cookieOnSite, listProfileSites, siteOf } from "../../src/engines/profile-sites";
import { agentProfileText } from "../../src/engines/profile-tabs";
import { profileQuestionResult } from "../../src/mcp/tool-card";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function chromeTime(ms: number): bigint {
  return (BigInt(ms) + 11_644_473_600_000n) * 1000n;
}

type Row = { host: string; name?: string; value?: string; expires?: number; lastUsed: number };

/** A Chrome Cookies file with the columns Bao reads, plus a value column that must never reach the model. */
async function cookieFile(profileDir: string, rows: Row[]): Promise<void> {
  await mkdir(path.join(profileDir, "Network"), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(profileDir, "Network", "Cookies"));
  try {
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, expires_utc INTEGER, last_access_utc INTEGER)");
    const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(row.host, row.name ?? "secret-cookie-name", row.value ?? "secret-cookie-value", row.expires === undefined ? 0n : chromeTime(row.expires), chromeTime(row.lastUsed));
    }
  } finally { db.close(); }
}

test("the site an open asks for is its host, never widened to a parent domain", () => {
  assert.equal(siteOf("https://app.robinhood.com/account/reports-statements?x=1"), "app.robinhood.com");
  assert.equal(siteOf("https://Robinhood.com./"), "robinhood.com");
  assert.equal(siteOf("https://alice.github.io/"), "alice.github.io");
  assert.equal(siteOf("http://127.0.0.1:8080/task"), "127.0.0.1");
  assert.equal(siteOf("about:blank"), undefined);
  assert.equal(siteOf("chrome://version"), undefined);
});

test("a cookie counts when Chrome would send it to the host or it belongs to a subdomain", () => {
  assert.equal(cookieOnSite(".robinhood.com", "app.robinhood.com"), true);
  assert.equal(cookieOnSite("app.robinhood.com", "app.robinhood.com"), true);
  assert.equal(cookieOnSite("api.app.robinhood.com", "app.robinhood.com"), true);
  assert.equal(cookieOnSite(".api.app.robinhood.com", "app.robinhood.com"), true);
  assert.equal(cookieOnSite("robinhood.com", "app.robinhood.com"), false);
  assert.equal(cookieOnSite("login.robinhood.com", "app.robinhood.com"), false);
  assert.equal(cookieOnSite(".notrobinhood.com", "robinhood.com"), false);
  assert.equal(cookieOnSite("bob.github.io", "alice.github.io"), false);
  assert.equal(cookieOnSite(".bob.github.io", "alice.github.io"), false);
});

test("tenants under a shared suffix do not count for each other", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-sites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cookieFile(path.join(root, "Default"), [{ host: "alice.github.io", lastUsed: NOW - DAY }]);
  await cookieFile(path.join(root, "Profile 2"), [{ host: "bob.github.io", lastUsed: NOW }, { host: ".bob.github.io", lastUsed: NOW }]);
  const sites = listProfileSites(root, ["Default", "Profile 2"], "https://alice.github.io/", NOW)!;
  assert.deepEqual(sites, { site: "alice.github.io", byDirectory: { Default: { cookies: 1, lastUsed: "2026-11-15" }, "Profile 2": { cookies: 0 } }, unread: {} });
  const profiles = [{ directory: "Default", name: "Alice", email: "" }, { directory: "Profile 2", name: "Bob", email: "" }];
  const asked = profileQuestionResult(new ChromeProfileQuestion(root, profiles, undefined).withListing({ byDirectory: {}, unread: "remote debugging is off" }, sites),
    { command: "open", args: ["https://alice.github.io/"] }, false);
  assert.match(asked.structuredContent.summary, /"Default" \(Alice\): alice\.github\.io: 1 cookie, last used 2026-11-15;/);
  assert.match(asked.structuredContent.summary, /"Profile 2" \(Bob\): no alice\.github\.io cookies;/);
  assert.deepEqual(asked.structuredContent.profiles.map((profile) => "siteCookies" in profile && profile.siteCookies), [{ cookies: 1, lastUsed: "2026-11-15" }, { cookies: 0 }]);
});

test("each profile reports its live cookies for the site and when it last used one, with debugging off", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-sites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cookieFile(path.join(root, "Default"), [
    { host: ".robinhood.com", lastUsed: NOW - 3 * DAY, expires: NOW + 30 * DAY },
    { host: "app.robinhood.com", lastUsed: NOW - DAY },
    { host: ".robinhood.com", name: "expired", lastUsed: NOW - 2 * DAY, expires: NOW - DAY },
    { host: ".notrobinhood.com", lastUsed: NOW },
    { host: "login.robinhood.com", lastUsed: NOW },
    { host: ".complysci.com", lastUsed: NOW },
  ]);
  await cookieFile(path.join(root, "Profile 2"), [{ host: ".google.com", lastUsed: NOW }]);
  await mkdir(path.join(root, "Profile 3"));
  await mkdir(path.join(root, "Profile 4"));
  await writeFile(path.join(root, "Profile 4", "Cookies"), "not a database");

  const sites = listProfileSites(root, ["Default", "Profile 2", "Profile 3", "Profile 4", "../escape"], "https://app.robinhood.com/statements", NOW)!;
  assert.deepEqual(sites, {
    site: "app.robinhood.com",
    byDirectory: { Default: { cookies: 2, lastUsed: "2026-11-15" }, "Profile 2": { cookies: 0 } },
    unread: { "Profile 3": "no cookie file", "Profile 4": "the cookie file could not be read" },
  });
  assert.equal(listProfileSites(root, ["Default"], "about:blank", NOW), undefined);

  const profiles = [
    { directory: "Default", name: "Alex", email: "alex@example.test" },
    { directory: "Profile 2", name: "Work", email: "work@example.test" },
    { directory: "Profile 3", name: "Spare", email: "" },
    { directory: "Profile 4", name: "Old", email: "" },
  ];
  const text = agentProfileText(root, profiles, "Profile 2", { byDirectory: {}, unread: "remote debugging is off" }, sites);
  assert.equal(text, [
    `Chrome has 4 profiles in ${root}, so Bao opened nothing. Pick one yourself from this list. Ask the person only if no profile fits the task. A profile with app.robinhood.com cookies has used that site and may be signed in there.`,
    '"Default" (Alex, alex@example.test): app.robinhood.com: 2 cookies, last used 2026-11-15; open tabs were not read (remote debugging is off)',
    '"Profile 2" (Work, work@example.test): no app.robinhood.com cookies; open tabs were not read (remote debugging is off); picked in Bao Settings',
    '"Profile 3" (Spare): app.robinhood.com cookies were not read (no cookie file); open tabs were not read (remote debugging is off)',
    '"Profile 4" (Old): app.robinhood.com cookies were not read (the cookie file could not be read); open tabs were not read (remote debugging is off)',
  ].join("\n"));
  assert.doesNotMatch(text, /secret-cookie-value|secret-cookie-name/);

  const question = new ChromeProfileQuestion(root, profiles, "Profile 2").withListing({ byDirectory: {}, unread: "remote debugging is off" }, sites);
  const asked = profileQuestionResult(question, { command: "open", args: ["https://app.robinhood.com/statements"] }, false);
  assert.equal(asked.structuredContent.summary, text);
  assert.equal(asked.structuredContent.site, "app.robinhood.com");
  assert.deepEqual(asked.structuredContent.profiles.map((profile) => [profile.directory, "siteCookies" in profile ? profile.siteCookies : profile.siteCookiesUnread]), [
    ["Default", { cookies: 2, lastUsed: "2026-11-15" }],
    ["Profile 2", { cookies: 0 }],
    ["Profile 3", "no cookie file"],
    ["Profile 4", "the cookie file could not be read"],
  ]);
  assert.doesNotMatch(JSON.stringify(asked), /secret-cookie-value|secret-cookie-name/);
});
