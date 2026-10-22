// Logins screen. Profiles and saved sites. Cookie values never appear here.

import type { BotCookiePolicy, PublicImportResult, PublicPreview, PublicProfile, SiteLoginConfig } from "../login-import/types";
import { formatClock, formatFriendly, formatWhen } from "../v1/time";
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

const SYNC_CATEGORIES = ["workflows", "run history", "heal records", "settings"] as const;

export function syncPanel(sync: {
  server?: string;
  deviceName?: string;
  paired?: boolean;
  lastResult?: string;
  lastSyncedAt?: string;
  inviteSaved?: boolean;
  backupPath?: string;
  devices?: { name: string; last_seen_at?: string | null }[];
  categories?: { category: string; count: number }[];
  localCategories?: { category: string; count: number }[];
  conflicts?: { id: string; remoteVersion: number; file: string }[];
  buckets?: { category: string; enabled: boolean; local: number; cloud: number }[];
  catchingUp?: boolean;
  backupSchedule?: string;
  lastBackupAt?: string;
  scheduledBackupPath?: string;
} | undefined, opened?: { id: string; name: string; steps: string[] } | null): string {
  const row = sync || {};
  const devices = (row.devices || []).map((device) => {
    const iso = device.last_seen_at || row.lastSyncedAt;
    return `<div class="device" data-testid="device-row"><strong>${esc(device.name)}</strong><span>${esc(rowTime(iso))}</span></div>`;
  }).join("");
  const account = (row.categories || []).map((item) => `<li>${esc(item.category)} <strong>${esc(item.count)}</strong></li>`).join("") || "<li>None yet.</li>";
  const local = (row.localCategories || []).map((item) => `<li>${esc(item.category)} <strong>${esc(item.count)}</strong></li>`).join("") || "<li>None yet.</li>";
  const conflicts = (row.conflicts || []).map((item) => {
    const open = opened && opened.id === item.id
      ? `<div data-testid="my-copy"><strong>${esc(opened.name)}</strong><ol>${opened.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol></div>`
      : "";
    return `<article class="card" data-testid="conflict">
      <h3>${esc(item.id)}</h3>
      <p class="quiet">Remote version ${esc(item.remoteVersion)} replaced the copy on this Mac.</p>
      ${open}
      <div class="row">
        <button type="button" data-open-conflict="${esc(item.id)}">Open my copy</button>
        <button type="button" data-keep-mine="${esc(item.id)}">Keep mine instead</button>
      </div>
    </article>`;
  }).join("");
  const refused = row.lastResult && /refused|secret|cookie/i.test(row.lastResult)
    ? `<article class="card" data-testid="sync-error"><h3>Push refused</h3><p>${esc(row.lastResult)}</p></article>`
    : "";
  return `<div class="card" id="sync-panel" data-testid="sync">
    <h3>Sync</h3>
    <p>Secrets, cookies, and unredacted screenshots stay on this Mac. The first sync copies the library into a backup before anything is sent.</p>
    <label>Server <input id="sync-server" value="${esc(row.server || "")}" placeholder="http://127.0.0.1:3000"></label>
    <label>Pairing code <input id="pair-code" autocomplete="off"></label>
    <label>Invite secret <input id="invite-secret" type="password" autocomplete="off" placeholder="${row.inviteSaved ? "Saved on this Mac" : "Paste once"}"></label>
    <p class="quiet">Paste the invite secret once, next to the pairing code. It stays in this Mac's sync file and is not sent on later syncs.</p>
    <label>Device name <input id="device-name" value="${esc(row.deviceName || "")}"></label>
    <div class="row">
      <button id="pair" type="button">Pair</button>
      <button class="primary" id="sync-now" type="button">Sync</button>
      <button id="sync-push" type="button">Push</button>
      <button id="sync-pull" type="button">Pull</button>
    </div>
    <p class="quiet" data-testid="sync-result">${esc(syncStatusLine(row))}</p>
    ${row.lastSyncedAt ? `<p class="quiet" data-testid="last-synced">This Mac last synced ${esc(clockTime(row.lastSyncedAt))}</p>` : ""}
    <div class="backup-row" data-testid="backup-row">
      <div class="backup-copy">
        <p class="quiet" data-testid="backup-label"${backupTip(row)}>${esc(backupLabel(row))}</p>
        ${revealBackup(row)}
      </div>
      <label>Back up <select id="backup-schedule" data-testid="backup-schedule">
        <option value="off" ${row.backupSchedule === "daily" || row.backupSchedule === "weekly" ? "" : "selected"}>Off</option>
        <option value="daily" ${row.backupSchedule === "daily" ? "selected" : ""}>Back up daily</option>
        <option value="weekly" ${row.backupSchedule === "weekly" ? "selected" : ""}>Back up weekly</option>
      </select></label>
    </div>
    <button id="restore-backup" type="button">Restore</button>
    <h3>Categories</h3>
    <ul class="sync-cats" data-testid="sync-categories">${categoryRows(row)}</ul>
    <h3>Devices</h3>
    <div data-testid="devices">${devices || `<p class="quiet">Pair this Mac to see your devices.</p>`}</div>
    <h3>On this Mac</h3><ul>${local}</ul>
    <h3>On the account</h3><ul>${account}</ul>
    ${refused}
    ${conflicts ? `<h3>Conflicts</h3>${conflicts}` : ""}
  </div>`;
}

function categoryRows(row: {
  buckets?: { category: string; enabled: boolean; local: number; cloud: number }[];
  catchingUp?: boolean;
}): string {
  const given = row.buckets || [];
  return SYNC_CATEGORIES.map((category) => {
    const bucket = given.find((item) => item.category === category) || { category, enabled: true, local: 0, cloud: 0 };
    const count = row.catchingUp
      ? `<p data-testid="catchup-count">${esc(bucket.local)} on this device of ${esc(bucket.cloud)} in the cloud</p>`
      : "";
    return `<li data-testid="sync-category" data-category="${esc(category)}">
      <label><input type="checkbox" data-sync-category="${esc(category)}"${bucket.enabled ? " checked" : ""}> ${esc(categoryLabel(category))}</label>
      ${count}
    </li>`;
  }).join("");
}

function categoryLabel(category: string): string {
  if (category === "workflows") return "Workflows";
  if (category === "run history") return "Run history";
  if (category === "heal records") return "Heal records";
  return "Settings";
}

function syncStatusLine(row: { lastResult?: string; paired?: boolean; conflicts?: unknown[] }): string {
  const open = row.conflicts?.length ?? 0;
  const text = row.lastResult || (row.paired ? "Paired" : "Not paired");
  return text.replace(/conflicts \d+/, `conflicts ${open}`);
}

function backupFolder(row: { scheduledBackupPath?: string; backupPath?: string }): string {
  return row.scheduledBackupPath || row.backupPath || "";
}

function backupAt(row: { lastBackupAt?: string; scheduledBackupPath?: string; backupPath?: string }): number | undefined {
  if (row.lastBackupAt) {
    const date = new Date(row.lastBackupAt);
    if (!Number.isNaN(date.getTime())) return date.getTime();
  }
  const match = /(?:scheduled|before-sync)-(\d{10,})/.exec(backupFolder(row));
  if (!match) return undefined;
  const at = Number(match[1]);
  return Number.isFinite(at) ? at : undefined;
}

function backupLabel(row: { lastBackupAt?: string; scheduledBackupPath?: string; backupPath?: string }): string {
  const at = backupAt(row);
  return at ? formatFriendly(at) : "Taken automatically before the first sync.";
}

function backupTip(row: { scheduledBackupPath?: string; backupPath?: string }): string {
  const folder = backupFolder(row);
  return folder ? ` title="${esc(folder)}"` : "";
}

function revealBackup(row: { scheduledBackupPath?: string; backupPath?: string }): string {
  const folder = backupFolder(row);
  if (!folder) return "";
  return `<button type="button" class="link" id="reveal-backup" data-testid="reveal-backup" title="${esc(folder)}">Reveal in Finder</button>`;
}

function clockTime(iso?: string | null): string {
  if (!iso) return "Not synced yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not synced yet";
  return formatClock(date.getTime());
}

function rowTime(iso?: string | null): string {
  if (!iso) return "Not synced yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not synced yet";
  return formatWhen(date.getTime());
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
