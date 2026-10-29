import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkboxReach } from "./consent";
import { AxUnavailable, checkboxState, chromeHelper } from "./ax";
import { listenPid, readDevToolsActivePort } from "./endpoint";
import { acquireCdpLock, releaseCdpLock } from "./lock";
import { publicPath, redactText } from "./session";
import { connectAndAllow } from "./connect";
import type { CdpSocket } from "./socket";

const HOSTS = new Set(["experian.com", "www.experian.com", "usa.experian.com"]);
const AGENT = process.env.BAO_AGENT_ID || "bc-7abc31f7-244f-5f8e-a046-bf7d60a33440";

export interface LoginDiffInput {
  existingLoggedIn: number;
  duplicateLoggedIn: boolean | null;
  duplicateOpened: boolean;
  cookieNamesMatch: boolean | null;
  sessionKeysMatch: boolean | null;
  webdriverOnDuplicate: boolean | null;
  originalSurvived: boolean | null;
}

/** A timeout page is not a signed-in dashboard. */
export function pageLooksSignedIn(pathname: string, password: boolean): boolean {
  if (password) return false;
  return !/login|sign-?in|signin|timeout|expired/i.test(pathname);
}

/** Which explanation the measurements support. Unknown stays unknown. */
export function loginDiffConclusion(input: LoginDiffInput): string {
  if (input.existingLoggedIn >= 2) {
    const extra = input.duplicateLoggedIn === true
      ? " A window.open duplicate also stayed signed in."
      : input.duplicateLoggedIn === false
        ? " A window.open duplicate was signed out, so a brand-new tab does not receive whatever the open tabs already hold."
        : "";
    return `Login is not locked to one tab. ${input.existingLoggedIn} already-open tabs are signed in.${extra}`;
  }
  if (input.duplicateOpened && input.duplicateLoggedIn === true && input.cookieNamesMatch === true) {
    return "A window.open duplicate stayed signed in, with the same cookie names. A new tab can keep the login.";
  }
  if (input.duplicateOpened && input.duplicateLoggedIn === false && input.sessionKeysMatch === false && input.cookieNamesMatch === true) {
    return "The window.open duplicate is signed out. Cookie names match the signed-in tab and session-storage keys do not, so the part that does not follow the new tab is session storage.";
  }
  if (input.duplicateOpened && input.duplicateLoggedIn === false && input.cookieNamesMatch === false) {
    return "The window.open duplicate is signed out and its cookie names differ from the signed-in tab.";
  }
  if (input.duplicateOpened && input.duplicateLoggedIn === false && input.webdriverOnDuplicate === true && input.sessionKeysMatch === true && input.cookieNamesMatch === true) {
    return "Storage matches and the new tab reports automation. The site is treating that tab as signed out.";
  }
  if (input.originalSurvived === false) return "unknown";
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashNames(names: string[]): string {
  return createHash("sha256").update(names.slice().sort().join("\n")).digest("hex").slice(0, 16);
}

interface Probe {
  targetId: string;
  path: string;
  heading: string;
  password: boolean;
  webdriver: boolean;
  session: number;
  local: number;
  sessionHash: string;
  cookies: number;
  httpOnly: number;
  cookieHash: string;
  loggedIn: boolean;
}

async function connect(): Promise<CdpSocket> {
  const helper = chromeHelper();
  const perms = await helper.permissions(false);
  if (perms.prompted) throw new Error("helper asked for a permission prompt");
  if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
  if (perms.screenCapture) throw new Error("BaoOSHelper screen recording is granted; not starting");
  const endpoint = await readDevToolsActivePort();
  const chromePid = await listenPid(endpoint.port);
  const box = await checkboxState(helper, chromePid);
  if (checkboxReach(box.summary) === "stop") throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
  if (box.summary.dialog.present || box.summary.dialog.buttonCount > 0) {
    throw new AxUnavailable("Allow dialog was already up; not connecting and not clicking", box.summary);
  }
  const opened = await connectAndAllow({
    helper,
    endpoint,
    dialogPresentBeforeConnect: false,
    axLog: path.join(process.cwd(), ".evidence", "cdp-live-ax.jsonl"),
    pid: box.pid || chromePid,
    timeoutMs: 90_000,
  });
  return opened.cdp;
}

async function measure(cdp: CdpSocket, targetId: string): Promise<Probe> {
  const attached = await cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached.sessionId || "";
  await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
  const evaluated = await cdp.send<{ result?: { value?: Record<string, unknown> } }>("Runtime.evaluate", {
    expression: `(() => {
      const hashOf = (storage) => {
        const names = [];
        for (let i = 0; i < storage.length; i += 1) names.push(storage.key(i) || "");
        names.sort();
        let hash = 5381;
        for (const name of names) {
          for (let i = 0; i < name.length; i += 1) hash = ((hash * 33) ^ name.charCodeAt(i)) >>> 0;
          hash = ((hash * 33) ^ 124) >>> 0;
        }
        return hash.toString(16);
      };
      const heading = ((document.querySelector("h1") || {}).innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80);
      return {
        path: location.pathname || "/",
        heading,
        password: !!document.querySelector("input[type=password]"),
        webdriver: navigator.webdriver === true,
        session: sessionStorage.length,
        local: localStorage.length,
        sessionHash: hashOf(sessionStorage),
      };
    })()`,
    returnByValue: true,
  }, sessionId);
  const value = evaluated.result?.value || {};
  let cookies = 0;
  let httpOnly = 0;
  let cookieHash = "";
  try {
    await cdp.send("Network.enable", {}, sessionId);
    const fetched = await cdp.send<{ cookies?: { name?: string; httpOnly?: boolean; domain?: string }[] }>("Network.getCookies", {
      urls: ["https://usa.experian.com/", "https://www.experian.com/", "https://experian.com/"],
    }, sessionId);
    const names = (fetched.cookies || []).map((cookie) => String(cookie.name || "")).filter(Boolean);
    cookies = names.length;
    httpOnly = (fetched.cookies || []).filter((cookie) => cookie.httpOnly).length;
    cookieHash = hashNames(names);
  } catch {
    cookies = -1;
  }
  await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  const pagePath = publicPath(String(value.path || "/"));
  const loggedIn = pageLooksSignedIn(pagePath, value.password === true);
  return {
    targetId,
    path: pagePath,
    heading: redactText(String(value.heading || "")),
    password: value.password === true,
    webdriver: value.webdriver === true,
    session: Number(value.session) || 0,
    local: Number(value.local) || 0,
    sessionHash: String(value.sessionHash || ""),
    cookies,
    httpOnly,
    cookieHash,
    loggedIn,
  };
}

async function pages(cdp: CdpSocket): Promise<{ targetId: string; url: string }[]> {
  const listed = await cdp.send<{ targetInfos?: { type?: string; targetId?: string; url?: string }[] }>("Target.getTargets");
  const found: { targetId: string; url: string }[] = [];
  for (const info of listed.targetInfos || []) {
    if (info.type !== "page" || !info.targetId || !info.url) continue;
    try {
      if (!HOSTS.has(new URL(info.url).hostname)) continue;
    } catch {
      continue;
    }
    found.push({ targetId: info.targetId, url: info.url });
  }
  return found;
}

async function diagnose(cdp: CdpSocket): Promise<unknown> {
  const open = await pages(cdp);
  const probes: Probe[] = [];
  for (const page of open) probes.push(await measure(cdp, page.targetId));
  const signedIn = probes.filter((probe) => probe.loggedIn);
  const source = signedIn[0];
  let duplicate: Probe | null = null;
  let duplicateOpened = false;
  let duplicateBlocked = false;
  let originalSurvived: boolean | null = source ? null : null;
  if (source) {
    const before = new Set(open.map((page) => page.targetId));
    const attached = await cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: source.targetId, flatten: true });
    const sessionId = attached.sessionId || "";
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
    const opened = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
      expression: `(() => { const tab = window.open(location.href, "_blank"); return tab ? "opened" : "blocked"; })()`,
      returnByValue: true,
    }, sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    duplicateOpened = opened.result?.value === "opened";
    duplicateBlocked = opened.result?.value === "blocked";
    if (duplicateOpened) {
      const deadline = Date.now() + 8_000;
      let created = "";
      while (Date.now() < deadline && !created) {
        const now = await pages(cdp);
        created = now.find((page) => !before.has(page.targetId))?.targetId || "";
        if (!created) await sleep(250);
      }
      if (created) {
        await sleep(1500);
        duplicate = await measure(cdp, created);
        await cdp.send("Target.closeTarget", { targetId: created }).catch(() => undefined);
      }
    }
    const again = await measure(cdp, source.targetId);
    originalSurvived = again.path === source.path && again.loggedIn === source.loggedIn;
  }
  const input: LoginDiffInput = {
    existingLoggedIn: signedIn.length,
    duplicateLoggedIn: duplicate ? duplicate.loggedIn : null,
    duplicateOpened: Boolean(duplicate),
    cookieNamesMatch: source && duplicate && source.cookieHash && duplicate.cookieHash
      ? source.cookieHash === duplicate.cookieHash
      : null,
    sessionKeysMatch: source && duplicate && source.sessionHash && duplicate.sessionHash
      ? source.sessionHash === duplicate.sessionHash
      : null,
    webdriverOnDuplicate: duplicate ? duplicate.webdriver : null,
    originalSurvived,
  };
  return {
    conclusion: loginDiffConclusion(input),
    existing: probes.map(({ targetId, cookieHash, sessionHash, ...probe }) => probe),
    duplicate: duplicate
      ? (({ targetId, cookieHash, sessionHash, ...probe }) => probe)(duplicate)
      : duplicateBlocked ? "blocked" : null,
    compared: {
      cookieNamesMatch: input.cookieNamesMatch,
      sessionKeysMatch: input.sessionKeysMatch,
      duplicateOpened,
      originalSurvived,
    },
  };
}

async function main(): Promise<void> {
  process.stderr.write("waiting for the browser lock\n");
  await acquireCdpLock(AGENT);
  let cdp: CdpSocket | undefined;
  try {
    cdp = await connect();
    const report = await diagnose(cdp);
    const dir = path.join(process.cwd(), ".evidence");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "login-diff.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    cdp?.close();
    releaseCdpLock(AGENT);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : "login diff failed"}\n`);
    process.exit(1);
  });
}
