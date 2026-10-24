import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import { startApp } from "../../src/app/server";
import { presentAvatar } from "../../src/login-import/avatar";
import { keepSessionCookies, OWNED_CHROME_ARGS, RESTORE_LAST_SESSION } from "../../src/launch";
import { classifyBotCookie } from "../../src/login-import/bot";
import { deriveAesKey, decryptCookieValue, encryptCookieValue, LINUX_ITERATIONS, LINUX_PEANUTS, MAC_ITERATIONS, plaintextForCookie } from "../../src/login-import/crypto";
import { importChromeLogin, observePage, preferredProfile, previewChromeProfiles, PROBE_SETTLE_MS } from "../../src/login-import/import-login";
import { describeKeys, keychainMessage, keyRingFromSources, linuxSecretLookups, macKeychainArgs, readPlatformKeys } from "../../src/login-import/keys";
import { judgeSignedIn, isLoginUrl } from "../../src/login-import/probe";
import { cookieMatchesHost, findCookieDb, loadDb, metaForChromeMajor, summarySql, withCookieDb } from "../../src/login-import/read";
import { buildReport } from "../../src/login-import/report";
import { NEEDS_SIGN_IN, runIfSignedIn } from "../../src/login-import/session-gate";
import { cdpCookieSetter, setCookiesOneAtATime, toSetCookie } from "../../src/login-import/set-cookies";
import { SiteStore } from "../../src/login-import/sites";
import { copyIndexedDb, decodeStorageBytes, encodeStorageBytes, indexedDbIdentifier, localStorageKey, originsForSite, readLocalStorage, setLocalStorageItems } from "../../src/login-import/storage";
import { ConsentRequired } from "../../src/login-import/types";
import type { DecryptedCookie } from "../../src/login-import/read";
import {
  assertNoValue,
  chromeExpiry,
  tempDir,
  TINY_PNG,
  writeCookieDb,
  writeIndexedDb,
  writeLevelStorage,
  writeLocalState,
  writeSqliteLocalStorage,
} from "./login-import-fixture";

const PEANUTS_V10_PREFIX = "djEwG7ZUgz+m+KcxUo25LWV9w3yHVEqBunh10GgSc1Q7Tk8ZO458TNh1qcysKHy7Pd5e";
const PEANUTS_V10_PLAIN = "djEwJOY9Pi6vVaXb0/61XIt0qA==";
const LIBSECRET_V11_PREFIX = "djEx7e5SJwAlaIBgsn7hlTCft79WyPe/UuZztB7QWA1jfUn4/YdzCGTCgltsdtsaKmmU";
const MAC_V10_PLAIN = "djEweiKsHjIPh9kHfs7zQIxCHg==";
const EMPTY_V10_PREFIX = "djEwW4a6CW4+Z3TjxolhkYrgOBR9w6d6JU8UkedQmeb6ZyEW0ukQ6Czi2R7qqcSEOwqi";
const SESSION = "session-secret-9f3c";
const STORAGE = "storage-secret-9f3c";

function okValue(result: { ok: boolean; value?: string; reason?: string }, expected: string): void {
  if (!result.ok || result.value !== expected) throw new Error(result.ok ? "decrypted value did not match" : `decrypt failed: ${result.reason}`);
}

test("meta versions follow the Chrome 1xx–15x cutovers, and the file version wins", () => {
  const cases: [number, number, boolean][] = [
    [100, 17, false],
    [101, 18, false],
    [116, 18, false],
    [117, 19, false],
    [118, 19, false],
    [119, 20, false],
    [120, 21, false],
    [122, 21, false],
    [123, 22, false],
    [124, 23, false],
    [129, 23, false],
    [130, 24, true],
    [156, 24, true],
  ];
  for (const [major, meta, prefix] of cases) {
    const got = metaForChromeMajor(major);
    assert.equal(got.meta, meta, String(major));
    assert.equal(got.hostPrefix, prefix, String(major));
  }
});

test("hardcoded v10, v11, peanuts, libsecret, and keychain ciphertexts decrypt", () => {
  const peanuts = { v10: deriveAesKey(LINUX_PEANUTS, LINUX_ITERATIONS) };
  okValue(decryptCookieValue(Buffer.from(PEANUTS_V10_PREFIX, "base64"), ".example.com", 24, peanuts), "alpha");
  okValue(decryptCookieValue(Buffer.from(PEANUTS_V10_PLAIN, "base64"), ".example.com", 18, peanuts), "alpha");
  const mismatch = decryptCookieValue(Buffer.from(PEANUTS_V10_PLAIN, "base64"), ".example.com", 24, peanuts);
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, "host prefix does not match");
  const linux = keyRingFromSources({ platform: "linux", secret: "keyring-secret" });
  okValue(decryptCookieValue(Buffer.from(LIBSECRET_V11_PREFIX, "base64"), "www.example.com", 24, linux), "beta");
  const missingV11 = decryptCookieValue(Buffer.from(LIBSECRET_V11_PREFIX, "base64"), "www.example.com", 24, keyRingFromSources({ platform: "linux" }));
  assert.equal(missingV11.ok, false);
  if (!missingV11.ok) assert.equal(missingV11.reason, "libsecret key is missing");
  const mac = keyRingFromSources({ platform: "darwin", secret: "bWFjLXBhc3M=" });
  okValue(decryptCookieValue(Buffer.from(MAC_V10_PLAIN, "base64"), "example.com", 23, mac), "gamma");
  assert.equal(deriveAesKey("bWFjLXBhc3M=", MAC_ITERATIONS).toString("hex"), "d2a2679a702433ad9d0afb33094f259e");
  okValue(decryptCookieValue(Buffer.from(EMPTY_V10_PREFIX, "base64"), ".example.com", 24, keyRingFromSources({ platform: "linux" })), "");
  const macNoEmpty = decryptCookieValue(Buffer.from(EMPTY_V10_PREFIX, "base64"), ".example.com", 24, mac);
  assert.equal(macNoEmpty.ok, false);
  const unsupported = decryptCookieValue(Buffer.from("v20aaaa"), "example.com", 24, peanuts);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.reason, "unsupported cipher");
});

test("a cookie DB matrix covers prefix, host, expiry, CHIPS, SameSite, and prefixes", () => {
  const future = chromeExpiry(Date.now() + 86_400_000);
  const past = chromeExpiry(Date.now() - 86_400_000);
  const majors = [100, 116, 129, 130, 156];
  for (const major of majors) {
    const { meta, hostPrefix } = metaForChromeMajor(major);
    const home = tempDir("bao-ck-");
    const file = path.join(home, "Network", "Cookies");
    const encrypted = encryptCookieValue(plaintextForCookie(".example.com", "alpha", hostPrefix), LINUX_PEANUTS, 1, "v10");
    writeCookieDb(file, meta, [
      { host: ".example.com", name: "sid", encrypted, secure: true, httpOnly: true, sameSite: 1, expires: future },
      { host: ".example.com", name: "gone", value: "old", expires: past, secure: true },
      { host: "other.example", name: "nope", value: "nope" },
    ]);
    const loaded = withCookieDb(file, (db) => loadDb(db, "www.example.com", "skip", keyRingFromSources({ platform: "linux" }), Date.now()));
    assert.equal(loaded.cookies.length, 1);
    okValue({ ok: true, value: loaded.cookies[0]?.value }, "alpha");
    assert.equal(loaded.skippedExpired, 1);
    assert.equal(loaded.cookies.some((cookie) => cookie.hostKey === "other.example"), false);
  }
  const cherry = tempDir("bao-cherry-");
  const cherryFile = path.join(cherry, "Cookies");
  writeCookieDb(cherryFile, 24, [{
    host: ".example.com",
    name: "sid",
    encrypted: Buffer.from(PEANUTS_V10_PREFIX, "base64"),
    secure: true,
    expires: future,
  }]);
  assert.equal(findCookieDb(cherry)?.kind, "legacy");
  const cherryLoaded = withCookieDb(cherryFile, (db) => loadDb(db, "example.com", "skip", keyRingFromSources({ platform: "linux" }), Date.now()));
  okValue({ ok: true, value: cherryLoaded.cookies[0]?.value }, "alpha");

  const shaped = tempDir("bao-shape-");
  const shapedFile = path.join(shaped, "Network", "Cookies");
  writeCookieDb(shapedFile, 24, [
    { host: "www.example.com", name: "hostonly", value: "h", secure: true, sameSite: -1 },
    { host: ".example.com", name: "domain", encrypted: Buffer.from(PEANUTS_V10_PREFIX, "base64"), secure: true, sameSite: 2, path: "/app" },
    { host: ".com", name: "suffix", value: "no" },
    { host: "www.example.com", name: "__Host-ok", value: "h", secure: true, path: "/", sameSite: 1 },
    { host: ".example.com", name: "__Host-bad", value: "h", secure: true, path: "/" },
    { host: "www.example.com", name: "__Secure-ok", value: "s", secure: true },
    { host: "www.example.com", name: "__Secure-bad", value: "s", secure: false },
    { host: "www.example.com", name: "loose", value: "n", secure: false, sameSite: 0 },
    {
      host: "www.example.com",
      name: "part",
      value: "p",
      secure: true,
      sameSite: 0,
      topFrame: "https://shop.example",
      crossSite: true,
    },
    { host: "www.example.com", name: "both", value: "both-secret-9f3c", encrypted: Buffer.from("v10aaaa"), secure: true },
    { host: "www.example.com", name: "reese84", value: "bot-body", secure: true },
  ]);
  const summary = withCookieDb(shapedFile, (db) => loadDb(db, "www.example.com", "skip", keyRingFromSources({ platform: "linux" }), Date.now()));
  assert.equal(summary.skippedBot.some((item) => item.name === "reese84" && item.vendor === "Imperva"), true);
  assert.equal(summary.cookies.some((cookie) => cookie.name === "reese84"), false);
  assert.equal(summary.failed.some((item) => item.reason === "plaintext and encrypted value both set"), true);
  assert.equal(summary.cookies.some((cookie) => cookie.name === "suffix"), false);
  const included = withCookieDb(shapedFile, (db) => loadDb(db, "www.example.com", "include", keyRingFromSources({ platform: "linux" }), Date.now()));
  assert.equal(included.cookies.some((cookie) => cookie.name === "reese84"), true);
  assert.equal(included.skippedBot.length, 0);

  const hostOnly = summary.cookies.find((cookie) => cookie.name === "hostonly");
  const domain = summary.cookies.find((cookie) => cookie.name === "domain");
  const part = summary.cookies.find((cookie) => cookie.name === "part");
  assert.ok(hostOnly && domain && part);
  const hostCall = toSetCookie(hostOnly);
  const domainCall = toSetCookie(domain);
  const partCall = toSetCookie(part);
  assert.equal(hostCall.ok && hostCall.call.domain, undefined);
  assert.equal(hostCall.ok && hostCall.call.sameSite, undefined);
  assert.equal(domainCall.ok && domainCall.call.domain, ".example.com");
  assert.equal(domainCall.ok && domainCall.call.sameSite, "Strict");
  assert.equal(domainCall.ok && domainCall.call.path, "/app");
  assert.deepEqual(partCall.ok && partCall.call.partitionKey, { topLevelSite: "https://shop.example", hasCrossSiteAncestor: true });
  const hostBad = summary.cookies.find((cookie) => cookie.name === "__Host-bad");
  const secureBad = summary.cookies.find((cookie) => cookie.name === "__Secure-bad");
  const loose = summary.cookies.find((cookie) => cookie.name === "loose");
  assert.ok(hostBad && secureBad && loose);
  const hostReject = toSetCookie(hostBad);
  const secureReject = toSetCookie(secureBad);
  const looseReject = toSetCookie(loose);
  assert.equal(hostReject.ok, false);
  assert.equal(secureReject.ok, false);
  assert.equal(looseReject.ok, false);
  if (!hostReject.ok) assert.equal(hostReject.reason.includes("__Host-"), true);
  assertNoValue(JSON.stringify(summary.failed), "both-secret-9f3c");
  assertNoValue(JSON.stringify(summary.skippedBot), "bot-body");
});

test("summary SQL never selects a cookie value", () => {
  const sql = summarySql(new Set([
    "host_key", "name", "path", "expires_utc", "has_expires", "is_secure", "is_httponly",
    "samesite", "top_frame_site_key", "has_cross_site_ancestor", "value", "encrypted_value",
  ]));
  assert.equal(/\bvalue\b/.test(sql), false);
  assert.equal(sql.includes("encrypted_value"), false);
});

test("host matching is exact for host-only cookies and one label short of a public suffix", () => {
  assert.equal(cookieMatchesHost("example.com", "example.com"), true);
  assert.equal(cookieMatchesHost("example.com", "www.example.com"), false);
  assert.equal(cookieMatchesHost(".example.com", "example.com"), true);
  assert.equal(cookieMatchesHost(".example.com", "www.example.com"), true);
  assert.equal(cookieMatchesHost(".com", "example.com"), false);
  assert.equal(cookieMatchesHost(".example.com", "example.org"), false);
});

test("bot-manager names are recognized and one rejection does not drop the next cookie", async () => {
  assert.equal(classifyBotCookie("visid_incap_1")?.vendor, "Imperva");
  assert.equal(classifyBotCookie("incap_ses_1")?.vendor, "Imperva");
  assert.equal(classifyBotCookie("nlbi_1")?.vendor, "Imperva");
  assert.equal(classifyBotCookie("___utmvc")?.vendor, "Imperva");
  assert.equal(classifyBotCookie("_abck")?.vendor, "Akamai");
  assert.equal(classifyBotCookie("bm_sz")?.vendor, "Akamai");
  assert.equal(classifyBotCookie("ak_bmsc")?.vendor, "Akamai");
  assert.equal(classifyBotCookie("cf_clearance")?.vendor, "Cloudflare");
  assert.equal(classifyBotCookie("__cf_bm")?.vendor, "Cloudflare");
  assert.equal(classifyBotCookie("cf_chl_1")?.vendor, "Cloudflare");
  assert.equal(classifyBotCookie("datadome")?.vendor, "DataDome");
  assert.equal(classifyBotCookie("_px3")?.vendor, "HUMAN");
  assert.equal(classifyBotCookie("_pxhd")?.vendor, "HUMAN");
  assert.equal(classifyBotCookie("pxcts")?.vendor, "HUMAN");
  assert.equal(classifyBotCookie("KP_UIDz-1")?.vendor, "Kasada");
  assert.equal(classifyBotCookie("session"), null);

  const good: DecryptedCookie = {
    id: 1, hostKey: "www.example.com", name: "sid", path: "/", secure: true, httpOnly: true,
    sameSite: 1, expired: false, botVendor: null, value: SESSION,
  };
  const bad: DecryptedCookie = { ...good, id: 2, name: "__Host-bad", hostKey: ".example.com", value: SESSION };
  const calls: string[] = [];
  const outcomes = await setCookiesOneAtATime({
    async setOne(cookie) {
      calls.push(cookie.name);
      return { success: true };
    },
  }, [bad, good]);
  assert.deepEqual(calls, ["sid"]);
  assert.equal(outcomes[0]?.ok, false);
  assert.equal(outcomes[1]?.ok, true);
  assertNoValue(JSON.stringify(outcomes), SESSION);

  const methods: string[] = [];
  const setter = cdpCookieSetter(async (method) => {
    methods.push(method);
    return { success: true };
  });
  await setter.setOne({ name: "sid", value: "x", url: "https://example.com/", path: "/", secure: true, httpOnly: false });
  assert.deepEqual(methods, ["Network.setCookie"]);
});

test("profile preview shows name, email, avatar, and counts, and skips other profiles' rows", async () => {
  const userData = tempDir("bao-profiles-");
  writeLocalState(userData, [
    { directory: "Default", name: "Ada Lovelace", email: "ada@example.com", avatar: TINY_PNG },
    { directory: "Profile 1", name: "Grace Hopper", email: "grace@example.com", avatar: TINY_PNG },
  ]);
  const future = chromeExpiry(Date.now() + 86_400_000);
  writeCookieDb(path.join(userData, "Default", "Network", "Cookies"), 24, [
    { host: ".example.com", name: "sid", encrypted: Buffer.from(PEANUTS_V10_PREFIX, "base64"), secure: true, expires: future },
    { host: ".example.com", name: "reese84", value: "bot-body", secure: true, expires: future },
    { host: ".example.com", name: "old", value: "old", secure: true, expires: chromeExpiry(Date.now() - 1000) },
  ]);
  writeCookieDb(path.join(userData, "Profile 1", "Network", "Cookies"), 24, [
    { host: "other.example", name: "sid", value: SESSION, secure: true },
  ]);
  const origin = "https://www.example.com";
  await writeLevelStorage(path.join(userData, "Default", "Local Storage", "leveldb"), [
    { key: localStorageKey(origin, "device"), value: encodeStorageBytes(STORAGE) },
    { key: localStorageKey("https://evil.example", "device"), value: encodeStorageBytes(STORAGE) },
    { key: Buffer.from("VERSION"), value: Buffer.from("1") },
  ]);
  writeIndexedDb(path.join(userData, "Default"), origin, "marker-example");
  writeIndexedDb(path.join(userData, "Default"), "https://evil.example", "marker-evil");
  const preview = await previewChromeProfiles({
    click: { site: `${origin}/home`, clicked: true },
    chromeUserData: userData,
    config: { botCookies: "skip", origins: ["https://evil.example", "https://www.example.com/app"] },
  });
  assert.equal(preview.chromeFound, true);
  assert.equal(preview.profiles.length, 2);
  const ada = preview.profiles.find((profile) => profile.directory === "Default");
  const grace = preview.profiles.find((profile) => profile.directory === "Profile 1");
  assert.ok(ada && grace);
  assert.equal(ada.name, "Ada Lovelace");
  assert.equal(ada.email, "ada@example.com");
  assert.equal(ada.avatarDataUrl, null);
  assert.equal(ada.avatarColor, "#ff8080");
  assert.equal(ada.matching, 2);
  assert.equal(ada.expired, 1);
  assert.equal(ada.botManager, 1);
  assert.equal(ada.willImport, 1);
  assert.equal(ada.localStorageItems, 1);
  assert.equal(ada.indexedDbOrigins, 1);
  assert.equal(grace.willImport, 0);
  assert.equal(grace.localStorageItems, 0);
  const blob = JSON.stringify(preview);
  assertNoValue(blob, STORAGE);
  assertNoValue(blob, "bot-body");
  assertNoValue(blob, "alpha");
  assertNoValue(blob, "marker-example");
});

test("a click is required before any profile read", async () => {
  const userData = tempDir("bao-consent-");
  mkdirSync(path.join(userData, "Local State"));
  await assert.rejects(
    () => previewChromeProfiles({
      click: { site: "https://example.com", clicked: false },
      chromeUserData: userData,
      config: { botCookies: "skip" },
    }),
    (err: unknown) => err instanceof ConsentRequired && err.message === "Bao reads a Chrome profile only after you click import for one site.",
  );
  await assert.rejects(
    () => previewChromeProfiles({
      click: { site: "https://example.com" },
      chromeUserData: userData,
      config: { botCookies: "skip" },
    }),
    (err: unknown) => err instanceof ConsentRequired,
  );
});

test("import sets one cookie at a time, restores storage counts, and omits values", async () => {
  const userData = tempDir("bao-import-");
  writeLocalState(userData, [{ directory: "Default", name: "Ada", email: "ada@example.com" }]);
  const future = chromeExpiry(Date.now() + 86_400_000);
  writeCookieDb(path.join(userData, "Default", "Network", "Cookies"), 24, [
    { host: "www.example.com", name: "sid", encrypted: Buffer.from(PEANUTS_V10_PREFIX, "base64").length ? encryptCookieValue(plaintextForCookie("www.example.com", SESSION, true), LINUX_PEANUTS, 1, "v10") : Buffer.alloc(0), secure: true, httpOnly: true, expires: future, sameSite: 1 },
    { host: "www.example.com", name: "reese84", value: "bot-body", secure: true, expires: future },
    { host: ".example.com", name: "__Host-bad", value: "x", secure: true, path: "/" },
  ]);
  const calls: { name: string; value: string }[] = [];
  let observed = 0;
  const result = await importChromeLogin({
    click: { site: "https://www.example.com/home", clicked: true },
    chromeUserData: userData,
    profileDirectory: "Default",
    config: {
      origin: "https://www.example.com",
      probeUrl: "https://www.example.com/home",
      signedInSelector: "#account",
      signedInText: "",
      botCookies: "skip",
      origins: [],
    },
    keys: { platform: "linux" },
    restoreStorage: async () => 2,
    indexedDbOrigins: 1,
    setOne: async (cookie) => {
      calls.push({ name: cookie.name, value: cookie.value });
      return { success: cookie.name !== "__Host-bad" };
    },
    observe: async () => {
      observed += 1;
      return { finalUrl: "https://www.example.com/home", selectorFound: true, bodyText: "" };
    },
  });
  assert.equal(observed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "sid");
  assert.equal(calls[0]?.value, SESSION);
  assert.equal(result.imported, 1);
  assert.equal(result.signedIn, true);
  assert.equal(result.headline, "Imported 1. Signed in: yes.");
  assert.equal(result.localStorageItems, 2);
  assert.equal(result.indexedDbOrigins, 1);
  assert.match(result.message, /Restored 2 localStorage items and 1 IndexedDB origin\./);
  assert.equal(result.message.includes("The probe found the signed-in selector."), true);
  assertNoValue(JSON.stringify(result), SESSION);
  assertNoValue(JSON.stringify(result), "bot-body");
  await assert.rejects(
    () => importChromeLogin({
      click: { site: "https://www.example.com", clicked: true },
      chromeUserData: userData,
      profileDirectory: "../Default",
      config: { origin: "https://www.example.com", probeUrl: "", signedInSelector: "", signedInText: "", botCookies: "skip", origins: [] },
      keys: { platform: "linux" },
      setOne: async () => { throw new Error("setter called"); },
      observe: async () => { throw new Error("probe called"); },
    }),
    /Unknown Chrome profile/,
  );
});

test("a missed keychain prompt does not decrypt, set cookies, or probe", async () => {
  let called = false;
  const result = await importChromeLogin({
    click: { site: "https://example.com", clicked: true },
    chromeUserData: tempDir("bao-key-"),
    profileDirectory: "Default",
    config: { origin: "https://example.com", probeUrl: "https://example.com/home", signedInSelector: "", signedInText: "", botCookies: "skip", origins: [] },
    keys: { platform: "darwin", secretError: "prompt-missed" },
    setOne: async () => { called = true; return { success: true }; },
    observe: async () => { called = true; return { finalUrl: "", selectorFound: false, bodyText: "" }; },
  });
  assert.equal(called, false);
  assert.equal(result.headline, "Imported 0. Signed in: no.");
  assert.equal(result.probed, false);
  assert.equal(result.keychain?.title, "Allow the Chrome Safe Storage prompt");
  assert.match(result.keychain?.body || "", /Click Always Allow\./);
  assert.match(result.message, /Bao did not load the site, because the cookies could not be decrypted\./);
  assertNoValue(JSON.stringify(result), "alpha");
});

test("keychain failures are classified from stderr, and the secret stays out of the copy", async () => {
  const missed = await readPlatformKeys({
    platform: "darwin",
    run: async () => ({ code: 1, stdout: "LEAKED-SECRET", stderr: "interaction is not allowed", timedOut: true }),
  });
  assert.equal(missed.secret, undefined);
  assert.equal(missed.secretError, "prompt-missed");
  const denied = await readPlatformKeys({
    platform: "darwin",
    run: async () => ({ code: 1, stdout: "LEAKED-SECRET", stderr: "user canceled", timedOut: false }),
  });
  assert.equal(denied.secretError, "denied");
  const missing = await readPlatformKeys({
    platform: "darwin",
    run: async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain.", timedOut: false }),
  });
  assert.equal(missing.secretError, "not-found");
  const described = describeKeys({ platform: "darwin", secret: "LEAKED-SECRET" });
  assert.equal(described.hasSecret, true);
  assertNoValue(JSON.stringify(described), "LEAKED-SECRET");
  assertNoValue(JSON.stringify(keychainMessage("prompt-missed")), "LEAKED-SECRET");
  assert.deepEqual(macKeychainArgs, ["find-generic-password", "-s", "Chrome Safe Storage", "-a", "Chrome", "-w"]);
  assert.equal(linuxSecretLookups[0]?.includes("chrome_libsecret_os_crypt_password_v2"), true);
  const linux = await readPlatformKeys({
    platform: "linux",
    run: async (_command, args) => args.includes("chrome_libsecret_os_crypt_password_v2")
      ? { code: 0, stdout: "keyring-secret\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "" },
  });
  assert.equal(linux.secret, "keyring-secret");
  assertNoValue(JSON.stringify(describeKeys(linux)), "keyring-secret");
});

test("probe failure names the anti-bot vendor and the sign-in-once path", () => {
  const reliable = "Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.";
  const skipped = buildReport({
    imported: 1,
    signedIn: false,
    skippedBot: [{ name: "reese84", vendor: "Imperva" }],
    policy: "skip",
    rejected: [],
    failed: [],
    skippedExpired: 0,
    probed: true,
    signInUrl: "https://example.com/home",
    keychain: null,
    probeHow: "login-url",
    includedBot: 0,
  });
  assert.equal(skipped.headline, "Imported 1. Signed in: no.");
  assert.match(skipped.message, /This site ties the session to its anti-bot cookies \(Imperva\)\./);
  assert.match(skipped.message, /Bao skipped those cookies\. Skipping them is the default, and the site sent Bao's Chrome to a login page\./);
  assert.equal(skipped.message.includes(reliable), true);
  assert.equal(skipped.offerSignIn, true);
  const included = buildReport({
    imported: 2,
    signedIn: false,
    skippedBot: [],
    policy: "include",
    rejected: [],
    failed: [],
    skippedExpired: 0,
    probed: true,
    signInUrl: "https://example.com/home",
    keychain: null,
    includedBot: 1,
  });
  assert.match(included.message, /Bao imported the anti-bot cookies as well\./);
  assert.match(included.message, /Those cookies are tied to the browser that received them\./);
  const onlyBot = buildReport({
    imported: 0,
    signedIn: false,
    skippedBot: [{ name: "cf_clearance", vendor: "Cloudflare" }],
    policy: "skip",
    rejected: [],
    failed: [],
    skippedExpired: 0,
    probed: false,
    signInUrl: "https://example.com/home",
    keychain: null,
    includedBot: 0,
  });
  assert.match(onlyBot.message, /This site only had anti-bot cookies \(Cloudflare\) for Bao to see\./);
  assert.equal(isLoginUrl("https://example.com/login"), true);
  assert.equal(isLoginUrl("https://example.com/account/sign-in"), true);
  assert.equal(isLoginUrl("https://example.com/home"), false);
  assert.equal(judgeSignedIn({ finalUrl: "https://example.com/login", selectorFound: false, bodyText: "" }, {}).signedIn, false);
  assert.equal(judgeSignedIn({ finalUrl: "https://example.com/login", selectorFound: true, bodyText: "Welcome back" }, { selector: "#account", text: "Welcome back" }).signedIn, true);
});

test("the signed-in probe waits out DOMContentLoaded for network idle and 5 seconds", async () => {
  const events: string[] = [];
  let settled = false;
  const page = {
    async goto(_url: string, opts: { waitUntil: string }) {
      events.push(`goto:${opts.waitUntil}`);
    },
    async waitForLoadState(state: string) {
      events.push(`idle:${state}`);
    },
    async waitForTimeout(ms: number) {
      assert.ok(ms >= PROBE_SETTLE_MS - 50, `settle wait was ${ms}`);
      events.push("wait");
      settled = true;
    },
    url() {
      events.push(settled ? "url:settled" : "url:early");
      return settled ? "https://member.example/home" : "https://member.example/login";
    },
    locator() {
      return { count: async () => 0, innerText: async () => "" };
    },
  };
  const obs = await observePage(page as never, "https://member.example/home", "", "");
  assert.deepEqual(events, ["goto:domcontentloaded", "idle:networkidle", "wait", "url:settled"]);
  assert.equal(obs.finalUrl, "https://member.example/home");
  assert.equal(judgeSignedIn(obs, {}).signedIn, true);

  const chatty: string[] = [];
  let chattySettled = false;
  const busy = {
    async goto() { chatty.push("goto"); },
    async waitForLoadState() {
      chatty.push("idle-timeout");
      throw new Error("timeout");
    },
    async waitForTimeout(ms: number) {
      assert.ok(ms >= PROBE_SETTLE_MS - 50);
      chatty.push("wait");
      chattySettled = true;
    },
    url() {
      chatty.push(chattySettled ? "url:settled" : "url:early");
      return "https://member.example/login";
    },
    locator() {
      return { count: async () => 0, innerText: async () => "" };
    },
  };
  const late = await observePage(busy as never, "https://member.example/account", "", "");
  assert.deepEqual(chatty, ["goto", "idle-timeout", "wait", "url:settled"]);
  assert.equal(late.finalUrl, "https://member.example/login");
  assert.equal(judgeSignedIn(late, {}).signedIn, false);
  assert.equal(judgeSignedIn(late, {}).how, "login-wall");
});

test("localStorage leveldb and sqlite keep the clicked origins, including latin1 and utf-16", async () => {
  const profile = tempDir("bao-ls-");
  const clicked = "https://www.example.com";
  const extra = "https://app.example.com";
  const evil = "https://evil.example";
  assert.deepEqual(originsForSite(`${clicked}/home`, [extra, evil, "not a url", clicked]), [clicked]);
  assert.deepEqual(originsForSite(`${clicked}/home`, [`${extra}/dashboard`]), [clicked]);
  const wanted = originsForSite("https://example.com/home", ["https://example.com:8443", "http://example.com"]);
  assert.deepEqual(wanted, ["https://example.com", "https://example.com:8443", "http://example.com"]);
  await writeLevelStorage(path.join(profile, "Local Storage", "leveldb"), [
    { key: localStorageKey(clicked, "device"), value: encodeStorageBytes("café") },
    { key: localStorageKey(clicked, "name", true), value: encodeStorageBytes("你好", true) },
    { key: localStorageKey(evil, "device"), value: encodeStorageBytes(STORAGE) },
    { key: Buffer.from("META:0"), value: Buffer.from("skip") },
  ]);
  const fromLevel = await readLocalStorage(profile, [clicked]);
  assert.equal(fromLevel.length, 2);
  assert.equal(fromLevel.some((item) => item.key === "device" && item.value === "café"), true);
  assert.equal(fromLevel.some((item) => item.key === "name" && item.value === "你好"), true);
  assert.equal(decodeStorageBytes(encodeStorageBytes("café")), "café");
  const sqliteProfile = tempDir("bao-lsql-");
  writeSqliteLocalStorage(path.join(sqliteProfile, "Local Storage", "localstorage.sqlite"), [
    { origin: clicked, key: encodeStorageBytes("device"), value: encodeStorageBytes(STORAGE) },
    { origin: evil, key: encodeStorageBytes("device"), value: encodeStorageBytes("other-secret") },
  ]);
  const fromSql = await readLocalStorage(sqliteProfile, [clicked]);
  assert.equal(fromSql.length, 1);
  assert.equal(fromSql[0]?.origin, clicked);
  assert.equal(fromSql[0]?.value, STORAGE);
  const sends: string[] = [];
  const stored = await setLocalStorageItems(async (method, params) => {
    sends.push(method);
    if (params.key === "device") throw new Error("set failed");
  }, fromSql.concat([{ origin: clicked, key: "ok", value: "yes" }]));
  assert.equal(stored, 1);
  assert.deepEqual(sends, ["DOMStorage.enable", "DOMStorage.setDOMStorageItem", "DOMStorage.setDOMStorageItem"]);
});

test("IndexedDB copy keeps the clicked origin and drops LOCK files", () => {
  const source = tempDir("bao-idb-src-");
  const bao = tempDir("bao-idb-dst-");
  const clicked = "https://example.com";
  const id = writeIndexedDb(source, clicked, "marker-example");
  writeIndexedDb(source, "https://evil.example", "marker-evil");
  writeIndexedDb(source, "http://example.com", "marker-http");
  assert.equal(indexedDbIdentifier("http://[::1]:8080"), "http_[__1]_8080");
  assert.equal(id, "https_example.com_0");
  const copied = copyIndexedDb(source, bao, [clicked]);
  assert.deepEqual(copied, [clicked]);
  const dest = path.join(bao, "Default", "IndexedDB");
  const names = readdirSync(dest);
  assert.deepEqual(names.sort(), [`${id}.indexeddb.blob`, `${id}.indexeddb.leveldb`]);
  assert.equal(existsSync(path.join(dest, `${id}.indexeddb.leveldb`, "LOCK")), false);
  assert.equal(readFileSync(path.join(dest, `${id}.indexeddb.leveldb`, "CURRENT"), "utf8"), "marker-example");
  assert.equal(names.some((name) => name.includes("evil")), false);
  assert.equal(names.some((name) => name.startsWith("http_")), false);
});

test("a dead session does not start the run", async () => {
  let ran = false;
  let probed = false;
  const dead = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-1",
    probe: async () => {
      probed = true;
      return { signedIn: false };
    },
    run: async () => { ran = true; return "ran"; },
  });
  assert.equal(probed, true);
  assert.equal(ran, false);
  if (typeof dead === "string" || dead.status !== "needs-sign-in") throw new Error("expected needs-sign-in");
  assert.deepEqual(dead.steps, []);
  assert.equal(dead.message, NEEDS_SIGN_IN);
  assert.equal(dead.offerSignIn, true);
  const thrown = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-2",
    probe: async () => { throw new Error("down"); },
    run: async () => { ran = true; return "ran"; },
  });
  if (typeof thrown === "string" || thrown.status !== "needs-sign-in") throw new Error("expected needs-sign-in");
  assert.equal(ran, false);
  const live = await runIfSignedIn({
    enabled: true,
    signInUrl: "https://example.com/home",
    runId: "run-3",
    probe: async () => ({ signedIn: true }),
    run: async () => "ran",
  });
  assert.equal(live, "ran");
  let gatedProbe = false;
  const skipped = await runIfSignedIn({
    enabled: false,
    signInUrl: "https://example.com/home",
    runId: "run-4",
    probe: async () => { gatedProbe = true; return { signedIn: false }; },
    run: async () => "open",
  });
  assert.equal(gatedProbe, false);
  assert.equal(skipped, "open");
});

test("saved sites keep same-host origins and unsaved origins are not gated", () => {
  const store = new SiteStore(path.join(tempDir("bao-sites-"), "login-sites.json"));
  assert.equal(store.has("https://example.com"), false);
  assert.equal(store.get("https://example.com").botCookies, "skip");
  const saved = store.save({
    origin: "https://www.example.com/home",
    probeUrl: "https://www.example.com/account",
    signedInSelector: "",
    signedInText: "",
    botCookies: "skip",
    origins: ["https://app.example.com/x", "https://evil.example", "https://www.example.com"],
  });
  assert.equal(store.has("https://www.example.com"), true);
  assert.deepEqual(saved.origins, ["https://www.example.com"]);
  assert.equal(saved.signedIn, null);
  assert.equal(saved.lastProbeAt, null);
  assert.throws(() => store.recordProbe("https://other.example", true), /That site is not saved/);
  const probed = store.recordProbe("https://www.example.com", true, 1_700_000_000_000);
  assert.equal(probed.signedIn, true);
  assert.equal(probed.lastProbeAt, 1_700_000_000_000);
  const kept = store.save({ ...probed, probeUrl: "https://www.example.com/inbox" });
  assert.equal(kept.signedIn, true);
  assert.equal(kept.lastProbeAt, 1_700_000_000_000);
  const same = store.save({ ...kept, origins: ["http://www.example.com/alt"] });
  assert.deepEqual(same.origins, ["http://www.example.com"]);
  store.remove("https://www.example.com/account");
  assert.equal(store.has("https://www.example.com"), false);
  store.remove("https://www.example.com");
});

test("a flat profile picture becomes initials on that color, and a photo stays an image", () => {
  const flat = presentAvatar(TINY_PNG);
  assert.equal(flat.avatarDataUrl, null);
  assert.equal(flat.avatarColor, "#ff8080");
  const photo = presentAvatar(rgbaPng(2, 2, Buffer.from([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ])));
  assert.equal(photo.avatarColor, null);
  assert.equal(photo.avatarDataUrl?.startsWith("data:image/png;base64,"), true);
  const solid = presentAvatar(rgbaPng(2, 1, Buffer.from([
    0, 0, 255, 255,
    0, 0, 255, 255,
  ])));
  assert.equal(solid.avatarDataUrl, null);
  assert.equal(solid.avatarColor, "#0000ff");
});

function rgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = 4;
  const raw = Buffer.alloc(height * (1 + width * stride));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * stride);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * stride, (y + 1) * width * stride);
  }
  const compressed = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

test("probe times use the machine zone", () => {
  const at = Date.parse("2026-10-22T04:04:00.000Z");
  const compiled = require.resolve("../../src/login-import/time");
  const eastern = probeTime(compiled, at, "America/New_York");
  assert.equal(eastern, "Oct 22, 12:04 AM EDT");
  const utc = probeTime(compiled, at, "UTC");
  assert.match(utc, /4:04 AM/);
  assert.match(utc, /UTC|GMT/);
  assert.equal(utc.includes("12:04"), false);
});

function probeTime(compiled: string, at: number, tz: string): string {
  const result = spawnSync(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(compiled)}).formatProbeTime(${at}))`], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("the profile with the most matches is preferred", () => {
  assert.equal(preferredProfile([]), null);
  assert.equal(preferredProfile([
    { directory: "Default", matching: 1, willImport: 1 },
    { directory: "Profile 1", matching: 2, willImport: 1 },
  ]), "Profile 1");
  assert.equal(preferredProfile([
    { directory: "Default", matching: 2, willImport: 1 },
    { directory: "Profile 1", matching: 2, willImport: 3 },
  ]), "Profile 1");
  assert.equal(preferredProfile([
    { directory: "Default", matching: 2, willImport: 2 },
    { directory: "Profile 1", matching: 2, willImport: 2 },
  ]), "Default");
});

test("bao's profile is set to continue where you left off", () => {
  const dir = tempDir("bao-prefs-");
  keepSessionCookies(dir);
  const file = path.join(dir, "Default", "Preferences");
  const prefs = JSON.parse(readFileSync(file, "utf8")) as { session: { restore_on_startup: number }; homepage?: string };
  assert.equal(prefs.session.restore_on_startup, RESTORE_LAST_SESSION);
  prefs.homepage = "https://example.com";
  writeFileSync(file, JSON.stringify(prefs));
  keepSessionCookies(dir);
  const again = JSON.parse(readFileSync(file, "utf8")) as { session: { restore_on_startup: number }; homepage?: string };
  assert.equal(again.session.restore_on_startup, 1);
  assert.equal(again.homepage, "https://example.com");
  writeFileSync(file, "{");
  keepSessionCookies(dir);
  const fresh = JSON.parse(readFileSync(file, "utf8")) as { session: { restore_on_startup: number }; homepage?: string };
  assert.equal(fresh.session.restore_on_startup, 1);
  assert.equal(fresh.homepage, undefined);
});

test("owned Chrome launch args do not hide automation", () => {
  const joined = OWNED_CHROME_ARGS.join(" ");
  assert.equal(joined.includes("AutomationControlled"), false);
  assert.equal(joined.includes("disable-blink-features"), false);
  assert.equal(OWNED_CHROME_ARGS.includes("--restore-last-session"), false);
});

test("the login routes refuse a read without a click and hide storage values", async () => {
  const userData = tempDir("bao-http-");
  mkdirSync(path.join(userData, "Local State"));
  const home = tempDir("bao-app-");
  const app = await startApp({ home, chromeUserData: userData, loginKeys: { platform: "linux" } });
  try {
    const denied = await fetch(`http://127.0.0.1:${app.port}/api/login-import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "https://example.com", consent: false }),
    });
    assert.equal(denied.status, 403);
    const body = await denied.json() as { error?: string };
    assert.equal(body.error, "Bao reads a Chrome profile only after you click import for one site.");
    const bad = await fetch(`http://127.0.0.1:${app.port}/api/login-import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "file:///tmp/secret", consent: true }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }

  const ready = tempDir("bao-http-ready-");
  writeLocalState(ready, [{ directory: "Default", name: "Ada Lovelace", email: "ada@example.com", avatar: TINY_PNG }]);
  writeCookieDb(path.join(ready, "Default", "Cookies"), 18, [
    { host: ".example.com", name: "sid", value: SESSION, secure: true },
  ]);
  await writeLevelStorage(path.join(ready, "Default", "Local Storage", "leveldb"), [
    { key: localStorageKey("https://example.com", "device"), value: encodeStorageBytes(STORAGE) },
  ]);
  const home2 = tempDir("bao-app-2-");
  const baoProfile = path.join(home2, "chrome-profile");
  const app2 = await startApp({
    home: home2,
    chromeUserData: ready,
    baoProfile,
    loginPlatform: "darwin",
    loginKeys: { platform: "darwin", secretError: "prompt-missed" },
  });
  try {
    const previewRes = await fetch(`http://127.0.0.1:${app2.port}/api/login-import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "https://example.com/home", consent: true, origins: "https://evil.example" }),
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as { profiles: { name: string; email: string; willImport: number; localStorageItems: number }[]; preferred: string | null; keychainNote: { title: string } | null };
    assert.equal(preview.profiles[0]?.name, "Ada Lovelace");
    assert.equal(preview.profiles[0]?.email, "ada@example.com");
    assert.equal(preview.profiles[0]?.willImport, 1);
    assert.equal(preview.profiles[0]?.localStorageItems, 1);
    assert.equal(preview.preferred, "Default");
    assert.equal(preview.keychainNote?.title, "macOS will ask for Chrome Safe Storage");
    assertNoValue(JSON.stringify(preview), SESSION);
    assertNoValue(JSON.stringify(preview), STORAGE);
    const imported = await fetch(`http://127.0.0.1:${app2.port}/api/login-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "https://example.com/home", consent: true, profile: "Default" }),
    });
    assert.equal(imported.status, 200);
    const report = await imported.json() as { headline: string; keychain: { body: string } | null; probed: boolean };
    assert.equal(report.headline, "Imported 0. Signed in: no.");
    assert.equal(report.probed, false);
    assert.match(report.keychain?.body || "", /Click Always Allow\./);
    assert.equal(existsSync(baoProfile), false);
    assertNoValue(JSON.stringify(report), SESSION);
    const listed = await fetch(`http://127.0.0.1:${app2.port}/api/login-sites`);
    const sites = await listed.json() as { sites: { origin: string; signedIn: boolean | null }[] };
    assert.equal(sites.sites.length, 1);
    assert.equal(sites.sites[0]?.signedIn, null);
    const removed = await fetch(`http://127.0.0.1:${app2.port}/api/login-sites`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://example.com" }),
    });
    assert.equal(removed.status, 200);
    const after = await (await fetch(`http://127.0.0.1:${app2.port}/api/login-sites`)).json() as { sites: unknown[] };
    assert.equal(after.sites.length, 0);
    const recheck = await fetch(`http://127.0.0.1:${app2.port}/api/login-sites/recheck`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://example.com" }),
    });
    assert.equal(recheck.status, 404);
    assert.equal(existsSync(baoProfile), false);
  } finally {
    await app2.close();
  }
});
