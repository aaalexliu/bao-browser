import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startApp } from "../../src/app/server";
import {
  auditLine,
  chooseProfile,
  chromeExpiresToUnix,
  cookieValueFromPlain,
  decryptSiteCookies,
  decryptV10,
  deriveChromeKey,
  explainImportError,
  hostMatches,
  lastUsedDirectory,
  importConfirmText,
  profilesFromLocalState,
  readSiteCookieRows,
  safeImportError,
  injectCookies,
  toCdpCookies,
  withCookiesCopy,
} from "../../src/v1/chrome-login";

const OTHER = "SHOULD-NOT-LEAK";
const LOOKALIKE = "ALSO-SECRET";
const EVIL = "EVIL-TOKEN";

function encrypt(plain: string, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
}

function seed(dbPath: string, key: Buffer): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT,
    name TEXT,
    value TEXT,
    encrypted_value BLOB,
    path TEXT,
    expires_utc INTEGER,
    is_secure INTEGER,
    is_httponly INTEGER,
    samesite INTEGER
  )`);
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const exp = BigInt(1700000000 + 11644473600) * 1_000_000n;
  insert.run("usa.experian.com", "sid", "", encrypt("site-token", key), "/", exp, 1, 1, 1);
  insert.run(".experian.com", "dot", "", encrypt("dot-token", key), "/", 0, 1, 0, 2);
  insert.run("experian.com", "plain", "plain-token", Buffer.alloc(0), "/", 0, 1, 0, -1);
  insert.run("accounts.google.com", "gid", OTHER, Buffer.alloc(0), "/", 0, 1, 1, 1);
  insert.run("notexperian.com", "bad", LOOKALIKE, Buffer.alloc(0), "/", 0, 1, 1, 1);
  insert.run("experian.com.evil.com", "bad", EVIL, Buffer.alloc(0), "/", 0, 1, 1, 1);
  insert.run("evil-experian.com", "bad", EVIL, Buffer.alloc(0), "/", 0, 1, 1, 1);
  db.close();
}

test("host match accepts the domain and subdomains only", () => {
  assert.equal(hostMatches("experian.com", "experian.com"), true);
  assert.equal(hostMatches(".experian.com", "experian.com"), true);
  assert.equal(hostMatches("usa.experian.com", "Experian.com"), true);
  assert.equal(hostMatches("notexperian.com", "experian.com"), false);
  assert.equal(hostMatches("experian.com.evil.com", "experian.com"), false);
  assert.equal(hostMatches("evil-experian.com", "experian.com"), false);
  assert.equal(hostMatches("experian.com/path", "experian.com"), false);
});

test("a synthetic cookies database returns only that site, and the temp copy is removed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-cookie-fixture-"));
  const dbPath = path.join(dir, "Cookies");
  const key = deriveChromeKey("test-password-not-a-keychain-secret");
  seed(dbPath, key);
  const rows = readSiteCookieRows(dbPath, "experian.com");
  const packed = JSON.stringify(rows);
  assert.equal(packed.includes(OTHER), false);
  assert.equal(packed.includes(LOOKALIKE), false);
  assert.equal(packed.includes(EVIL), false);
  assert.equal(packed.includes("accounts.google.com"), false);
  assert.equal(packed.includes("notexperian.com"), false);
  assert.equal(rows.length, 3);

  const cookies = decryptSiteCookies(rows, key, "experian.com");
  assert.equal(cookies.length, 3);
  assert.equal(cookies.every((cookie) => cookie.domain === "experian.com" || cookie.domain.endsWith(".experian.com")), true);
  assert.equal(cookies.some((cookie) => cookie.value === "site-token" && cookie.httpOnly && cookie.expires === 1700000000), true);
  assert.equal(cookies.some((cookie) => cookie.value === "dot-token" && cookie.hostOnly === false), true);
  assert.equal(cookies.some((cookie) => cookie.value === "plain-token" && cookie.hostOnly), true);
  assert.equal(JSON.stringify(cookies).includes(OTHER), false);
  const cdp = toCdpCookies(cookies);
  const hostOnly = cdp.find((cookie) => cookie.name === "sid");
  const domainCookie = cdp.find((cookie) => cookie.name === "dot");
  assert.equal(hostOnly?.domain, undefined);
  assert.equal(domainCookie?.domain, "experian.com");
  assert.equal(cdp.some((cookie) => cookie.name === "gid"), false);

  let copied = "";
  await withCookiesCopy(dbPath, (copy) => {
    copied = copy;
    assert.equal(existsSync(copy), true);
    assert.equal(readSiteCookieRows(copy, "experian.com").length, 3);
    writeFileSync(dbPath + "-journal", "journal-bytes");
  });
  await withCookiesCopy(dbPath, (copy) => {
    assert.equal(existsSync(copy + "-journal"), true);
  });
  assert.equal(existsSync(copied), false);
  assert.equal(existsSync(path.dirname(copied)), false);
});

test("a host hash prefix is removed and a raw value is left as-is", () => {
  const host = ".experian.com";
  const key = deriveChromeKey("test-password-not-a-keychain-secret");
  const hash = createHash("sha256").update(host).digest();
  const prefixed = Buffer.concat([hash, Buffer.from("session")]);
  assert.equal(cookieValueFromPlain(prefixed, host), "session");
  assert.equal(cookieValueFromPlain(Buffer.from("session"), host), "session");
  assert.notEqual(cookieValueFromPlain(prefixed, "usa.experian.com"), "session");
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(prefixed), cipher.final()]);
  assert.equal(decryptV10(encrypted, key, host), "session");
  assert.notEqual(decryptV10(encrypted, key), "session");
});

test("profile names come from info_cache and a tie is not guessed", () => {
  const raw = JSON.stringify({
    os_crypt: { encrypted_key: "SECRETKEY" },
    profile: {
      info_cache: {
        Default: { name: "Personal", user_name: "ada@example.test", gaia_name: "Ada Lovelace" },
        "Profile 1": { name: "Work", user_name: "work@example.test" },
        "Profile 2": { gaia_name: "Fallback" },
      },
    },
  });
  const profiles = profilesFromLocalState(raw);
  const packed = JSON.stringify(profiles);
  assert.equal(packed.includes("SECRETKEY"), false);
  assert.equal(packed.includes("ada@example.test"), false);
  assert.equal(packed.includes("Ada Lovelace"), false);
  assert.deepEqual(profiles.map((profile) => profile.name), ["Fallback", "Personal", "Work"]);
  const marked = JSON.parse(raw) as { profile: { last_used?: string } };
  marked.profile.last_used = "Profile 1";
  const withLast = profilesFromLocalState(JSON.stringify(marked)).map((profile) => (
    profile.directory === lastUsedDirectory(JSON.stringify(marked)) ? { ...profile, lastUsed: true } : profile
  ));
  assert.equal(withLast.find((profile) => profile.directory === "Profile 1")?.lastUsed, true);
  assert.equal(JSON.stringify(withLast).includes("work@example.test"), false);
  const choice = chooseProfile(profiles);
  assert.equal(choice.ok, false);
  if (!choice.ok) assert.equal(choice.reason, "pick");
  const one = chooseProfile(profiles, "Work");
  assert.equal(one.ok && one.profile.directory, "Profile 1");
  const only = chooseProfile([{ directory: "Default", name: "Personal" }]);
  assert.equal(only.ok && only.profile.directory, "Default");
});

test("confirm copy, audit line, and errors omit cookie material", () => {
  assert.equal(importConfirmText("experian.com"), "import your experian.com login from Chrome? only cookies for this site are copied");
  const line = auditLine({ domain: "experian.com", count: 2, at: 10 });
  assert.equal(line, "{\"domain\":\"experian.com\",\"count\":2,\"at\":10}");
  assert.equal(chromeExpiresToUnix(0), undefined);
  const key = deriveChromeKey("k");
  assert.throws(() => decryptV10(Buffer.from("v11abcdefghijklmnop"), key), /unsupported cookie encryption/);
  assert.equal(safeImportError(new Error("cookie=site-token")), "Import failed. Press Import again.");
  assert.equal(explainImportError(new Error("cookie=site-token")).includes("site-token"), false);
  assert.equal(safeImportError(new Error("keychain prompt was not approved")), "The keychain prompt was not approved. Press Import and choose Allow.");
  assert.equal(
    explainImportError(new Error("zero matching cookies"), "Profile 1"),
    "Profile Profile 1 has no cookies for this site. Press Import and pick the Chrome profile that is signed in.",
  );
  const failure = auditLine({
    domain: "experian.com",
    count: 0,
    at: 10,
    reason: explainImportError(new Error("could not import cookies")),
    profile: "Default",
  });
  assert.equal(failure.includes("site-token"), false);
  assert.equal(failure.includes("The browser rejected every cookie"), true);
  assert.equal(failure.includes("\"profile\":\"Default\""), true);
});

test("import-login stays on the confirm step and does not read Chrome", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-import-home-"));
  const chrome = path.join(home, "chrome");
  const previous = process.env.BAO_CHROME_USER_DATA;
  process.env.BAO_CHROME_USER_DATA = chrome;
  const app = await startApp({ home, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/import-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "chrome", domain: "experian.com", profile: "Personal" }),
    });
    const body = await res.json() as { phase: string; message: string };
    assert.equal(res.status, 200);
    assert.equal(body.phase, "confirm");
    assert.equal(body.message, "import your experian.com login from Chrome? only cookies for this site are copied");
    assert.equal(existsSync(chrome), false);
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { pendingImport: { message: string } };
    assert.equal(state.pendingImport.message, body.message);
  } finally {
    if (previous === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previous;
    await app.close();
  }
});

test("after confirm, several Chrome profiles are listed and cookies stay unread", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-import-pick-"));
  const chrome = path.join(home, "chrome");
  const previous = process.env.BAO_CHROME_USER_DATA;
  process.env.BAO_CHROME_USER_DATA = chrome;
  mkdirSync(chrome, { recursive: true });
  writeFileSync(path.join(chrome, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: "Personal", user_name: "secret@example.test" },
        "Profile 1": { name: "Work" },
      },
    },
  }));
  const app = await startApp({ home, port: 0 });
  try {
    const opened = await (await fetch(`http://127.0.0.1:${app.port}/api/import-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "chrome", domain: "experian.com" }),
    })).json() as { id: string };
    await fetch(`http://127.0.0.1:${app.port}/api/import-login/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: opened.id, accept: true }),
    });
    let phase = "";
    let packed = "";
    for (let i = 0; i < 20 && phase !== "pick" && phase !== "error" && phase !== "done"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const pending = (await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { pendingImport: unknown }).pendingImport;
      packed = JSON.stringify(pending);
      phase = (pending as { phase?: string }).phase || "";
    }
    assert.equal(phase, "pick");
    assert.equal(packed.includes("secret@example.test"), false);
    assert.equal(packed.includes("Personal"), true);
    assert.equal(packed.includes("Work"), true);
    assert.equal(existsSync(path.join(home, "audit", "import-login.jsonl")), false);
  } finally {
    if (previous === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previous;
    await app.close();
  }
});

test("a rejected cookie does not drop the rest of the import", async () => {
  const sent: string[] = [];
  const page = {
    context() {
      return {
        async newCDPSession() {
          return {
            async send(_method: string, params: { cookies: { name: string; path: string }[] }) {
              const cookie = params.cookies[0];
              if (cookie.name === "bad") throw new Error("Invalid cookie fields");
              sent.push(`${cookie.name}:${cookie.path}`);
            },
            async detach() {},
          };
        },
      };
    },
  };
  const count = await injectCookies(page, [
    { name: "good", value: "ok", domain: "experian.com", hostOnly: true, path: "noslash", secure: true, httpOnly: true },
    { name: "bad name", value: "nope", domain: "experian.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
    { name: "bad", value: "nope", domain: "experian.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
  ]);
  assert.equal(count, 1);
  assert.deepEqual(sent, ["good:/"]);
  assert.equal(sent.join(" ").includes("nope"), false);
});
