// Logins screen. Profiles and saved sites. Cookie values never appear here.

import type { BotCookiePolicy, PublicImportResult, PublicPreview, PublicProfile, SiteLoginConfig } from "../login-import/types";
import { esc } from "./views";

export interface SavedSite extends SiteLoginConfig {
  lastProbeLabel?: string | null;
}

export interface LoginForm {
  site: string;
  probeUrl: string;
  selector: string;
  text: string;
  origins: string;
  botCookies: BotCookiePolicy;
  advancedOpen: boolean;
  selected: string;
  settled: boolean;
  preview: PublicPreview | null;
  report: PublicImportResult | null;
  error: string;
  saved: SavedSite[];
}

export function emptyLogin(): LoginForm {
  return {
    site: "",
    probeUrl: "",
    selector: "",
    text: "",
    origins: "",
    botCookies: "skip",
    advancedOpen: false,
    selected: "",
    settled: false,
    preview: null,
    report: null,
    error: "",
    saved: [],
  };
}

export function loginAct(login: LoginForm): string {
  if (login.settled) return "";
  const preview = login.preview;
  const chosen = chosenProfile(login);
  if (!preview || !chosen) return "";
  const host = preview.host || "this site";
  return `<section id="act-bar" data-ask="import">
    <p class="kicker">You need to act · import ${esc(host)}</p>
    <p class="instruction">Import ${esc(chosen.name)} for ${esc(host)}. Bao reads only this site.</p>
    <div class="row">
      <button class="primary" id="import-selected" type="button">Import from ${esc(chosen.name)}</button>
      <button type="button" id="import-decline">Decline</button>
    </div>
  </section>`;
}

export function loginsScreen(login: LoginForm): string {
  const preview = login.preview;
  const profiles = preview?.profiles?.map((profile) => profileCard(profile, login.selected)).join("") || "";
  const note = preview?.keychainNote
    ? `<div class="notice"><strong>${esc(preview.keychainNote.title)}</strong><div>${esc(preview.keychainNote.body)}</div></div>`
    : "";
  const missing = preview && preview.chromeFound === false ? `<p>Bao did not find Chrome's Local State. Nothing was read.</p>` : "";
  const empty = preview && preview.chromeFound && profiles === "" ? `<p>Chrome has no profiles in Local State.</p>` : "";
  const report = login.report ? renderLoginReport(login.report) : "";
  const error = login.error ? `<div class="notice"><strong>Import</strong><div>${esc(login.error)}</div></div>` : "";
  return `<section><h2>Logins</h2>
    <p class="lede">Name a site, then import its login from your Chrome. Bao reads that site only, and only after this click. Values are not shown.</p>
    ${savedLogins(login.saved)}
    <div class="card">
      <label>Site <input id="login-site" value="${esc(login.site)}" placeholder="https://www.example.com/account"></label>
      <details id="login-advanced" ${login.advancedOpen ? "open" : ""}>
        <summary>Advanced</summary>
        <p class="hint">A blank probe uses the page in Site. With no selector and no text, Bao checks whether that page landed on a login URL. Extra origins must be the same host. Anti-bot cookies are skipped unless you include them here.</p>
        <label>Probe URL <input id="login-probe" value="${esc(login.probeUrl)}" placeholder="Page that redirects to login when signed out"></label>
        <label>Same-host origins <input id="login-origins" value="${esc(login.origins)}" placeholder="Optional. https://app.example.com"></label>
        <label>Signed-in selector <input id="login-selector" value="${esc(login.selector)}" placeholder="Optional. Example: #account"></label>
        <label>Signed-in text <input id="login-text" value="${esc(login.text)}" placeholder="Optional. Example: Welcome back"></label>
        <label>Anti-bot cookies <select id="login-bots">
          <option value="skip" ${login.botCookies === "skip" ? "selected" : ""}>Skip (default)</option>
          <option value="include" ${login.botCookies === "include" ? "selected" : ""}>Include for this site</option>
        </select></label>
      </details>
      <div class="row"><button class="primary" id="show-profiles" type="button">Import this site's login from my Chrome</button></div>
    </div>
    ${error}${note}${missing}${empty}
    <div class="profiles">${profiles}</div>
    ${report}
  </section>`;
}

export function needsSignInHtml(message: string): string {
  return `<div class="row fail" id="run-status"><strong>Needs sign-in</strong></div><p>${esc(message)}</p><button id="run-sign-in" type="button">Sign in once in Bao's window</button>`;
}

function chosenProfile(login: LoginForm): PublicProfile | null {
  const profiles = login.preview?.profiles || [];
  return profiles.find((profile) => profile.directory === login.selected) || profiles[0] || null;
}

function savedLogins(sites: SavedSite[]): string {
  if (!sites.length) return `<div class="card" id="saved-logins"><h3>Saved sites</h3><p class="quiet">No sites yet. Import one to keep it here.</p></div>`;
  const rows = sites.map((site) => {
    const badge = site.signedIn === true
      ? `<span class="status passed">Live</span>`
      : site.signedIn === false
        ? `<span class="status paused">Needs sign-in</span>`
        : `<span class="status unchecked">Not checked</span>`;
    const when = site.lastProbeLabel
      ? `Last checked ${esc(site.lastProbeLabel)}`
      : site.lastProbeAt ? `Last checked ${esc(formatWhen(site.lastProbeAt))}` : "Not checked yet";
    return `<div class="row saved-row" data-saved-origin="${esc(site.origin)}">
      <strong>${esc(site.origin)}</strong>
      ${badge}
      <span class="quiet">${when}</span>
      <button type="button" data-recheck="${esc(site.origin)}">Re-check</button>
      <button type="button" data-remove="${esc(site.origin)}">Remove</button>
    </div>`;
  }).join("");
  return `<div class="card" id="saved-logins"><h3>Saved sites</h3>${rows}</div>`;
}

function profileCard(profile: PublicProfile, selected: string): string {
  const on = profile.directory === selected;
  const bot = profile.botManager ? `<div class="meta">${profile.botManager} anti-bot ${profile.botManager === 1 ? "cookie" : "cookies"} skipped</div>` : "";
  const expired = profile.expired ? `<div class="meta">${profile.expired} expired left behind</div>` : "";
  const storage = `<div class="meta">${profile.localStorageItems || 0} localStorage ${(profile.localStorageItems || 0) === 1 ? "item" : "items"} · ${profile.indexedDbOrigins || 0} IndexedDB ${(profile.indexedDbOrigins || 0) === 1 ? "origin" : "origins"}</div>`;
  return `<button type="button" class="profile${on ? " on" : ""}" data-import-profile="${esc(profile.directory)}" aria-pressed="${on ? "true" : "false"}">
    ${profileMark(profile)}
    <span><strong>${esc(profile.name)}</strong><div class="email">${esc(profile.email || "No account email")}</div>
    <div class="meta">${profile.matching} ${profile.matching === 1 ? "cookie matches" : "cookies match"} this site · will import ${profile.willImport}</div>
    ${storage}${bot}${expired}</span>
  </button>`;
}

function profileMark(profile: PublicProfile): string {
  if (profile.avatarDataUrl) return `<img class="avatar" alt="" src="${esc(profile.avatarDataUrl)}">`;
  const color = /^#[0-9a-fA-F]{6}$/.test(profile.avatarColor || "") ? profile.avatarColor : "";
  const style = color ? ` style="background:${esc(color || "")};color:${esc(inkFor(color || "#000000"))}"` : "";
  return `<div class="avatar"${style}>${esc(initials(profile.name))}</div>`;
}

function renderLoginReport(report: PublicImportResult): string {
  const tone = report.signedIn ? "pass" : "fail";
  const keychain = report.keychain ? `<div class="notice"><strong>${esc(report.keychain.title)}</strong><div>${esc(report.keychain.body)}</div></div>` : "";
  const rejected = (report.rejected || []).map((item) => `<div>${esc(item.name)} · ${esc(item.reason)}</div>`).join("");
  const failed = (report.failed || []).map((item) => `<div>${esc(item.name)} · ${esc(item.reason)}</div>`).join("");
  const signIn = report.offerSignIn ? `<button id="sign-in-once" type="button">Sign in once in Bao's window</button>` : "";
  return `<div class="card result" id="login-result"><h3 class="${tone}">${esc(report.headline)}</h3><p>${esc(report.message || "")}</p>${keychain}${rejected}${failed}<div class="row">${signIn}</div></div>`;
}

export function preferredDirectory(profiles: { directory: string; matching: number; willImport: number }[]): string {
  let best: { directory: string; matching: number; willImport: number } | null = null;
  for (const profile of profiles) {
    if (!best || profile.willImport > best.willImport || (profile.willImport === best.willImport && profile.matching > best.matching)) best = profile;
  }
  return best?.directory || "";
}

export function syncPanel(sync: {
  server?: string;
  deviceName?: string;
  paired?: boolean;
  lastResult?: string;
  backupPath?: string;
  devices?: { name: string }[];
  categories?: { category: string; count: number }[];
  localCategories?: { category: string; count: number }[];
  conflicts?: { id: string; remoteVersion: number; file: string }[];
} | undefined): string {
  const row = sync || {};
  const devices = (row.devices || []).map((device) => `<li>${esc(device.name)}</li>`).join("") || "<li>Pair this Mac to see your devices.</li>";
  const account = (row.categories || []).map((item) => `<li>${esc(item.category)} <strong>${esc(item.count)}</strong></li>`).join("") || "<li>None yet.</li>";
  const local = (row.localCategories || []).map((item) => `<li>${esc(item.category)} <strong>${esc(item.count)}</strong></li>`).join("") || "<li>None yet.</li>";
  const conflicts = (row.conflicts || []).map((item) => `<li>${esc(item.id)} kept remote v${esc(item.remoteVersion)}. Your copy is ${esc(item.file)}</li>`).join("");
  return `<div class="card" id="sync-panel">
    <h3>Sync</h3>
    <p>Secrets, cookies, and unredacted screenshots stay on this Mac. The first sync copies the library into a backup before anything is sent.</p>
    <label>Server <input id="sync-server" value="${esc(row.server || "")}" placeholder="http://127.0.0.1:3000"></label>
    <label>Pairing code <input id="pair-code" autocomplete="off"></label>
    <label>Device name <input id="device-name" value="${esc(row.deviceName || "")}"></label>
    <div class="row">
      <button id="pair" type="button">Pair</button>
      <button class="primary" id="sync-now" type="button">Sync</button>
      <button id="sync-push" type="button">Push</button>
      <button id="sync-pull" type="button">Pull</button>
    </div>
    <p>Last result: ${esc(row.lastResult || "Not synced yet.")}</p>
    <p>Backup: ${esc(row.backupPath || "Taken automatically before the first sync.")}</p>
    <p>Paired: ${row.paired ? "yes" : "no"}</p>
    <h3>Devices</h3><ul>${devices}</ul>
    <h3>On this Mac</h3><ul>${local}</ul>
    <h3>On the account</h3><ul>${account}</ul>
    ${conflicts ? `<h3>Conflicts</h3><ul>${conflicts}</ul>` : ""}
  </div>`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0] || "").join("") || "?").toUpperCase();
}

function inkFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1d1f" : "#ffffff";
}

function formatWhen(at: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(at));
  } catch {
    return "";
  }
}
