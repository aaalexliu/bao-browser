import type { Settings } from "../v1/store";
import { controlKey } from "../v1/visible-copy";
import type { SavedSite } from "./logins-view";
import { esc, htmlEsc, icon as shellIcon, type ShellState } from "./views";

interface SettingsView {
  settings?: Partial<Settings>;
  helper?: ShellState["helper"];
  model?: ShellState["model"];
  relay?: { paired?: boolean };
  sites: SavedSite[];
}

const sections = [
  ["runs", "redo", "Runs and heals"],
  ["perm", "hand", "Mac permissions"],
  ["remote", "remote", "Remote access"],
  ["logins", "key", "Logins"],
  ["ai", "sparkle", "AI help"],
] as const;

function icon(name: string): string {
  const shapes: Record<string, string> = {
    redo: '<path d="M12.5 5.5A5.25 5.25 0 1 0 13 9"/><path d="M13 2.5v3.25H9.75"/>',
    hand: '<path d="M5.25 8.5V3.75a1 1 0 0 1 2 0V7.5M7.25 7V2.75a1 1 0 0 1 2 0V7M9.25 7V3.75a1 1 0 0 1 2 0v4.5M11.25 6.5a1 1 0 0 1 2 0v2.75a4.75 4.75 0 0 1-4.75 4.75h-.4a4.1 4.1 0 0 1-3.3-1.66L2.9 9.85a1 1 0 0 1 1.5-1.3l.85.95"/>',
    eye: '<path d="M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z"/><circle cx="8" cy="8" r="1.75"/>',
    remote: '<rect x="2.25" y="2.75" width="11.5" height="7.5" rx="1.5"/><path d="M5.5 13.25h5M8 10.25v3"/>',
    key: '<circle cx="5.25" cy="10.75" r="2.5"/><path d="m7 9 6-6M11 5l1.5 1.5M9.5 6.5 11 8"/>',
    sparkle: '<path d="M8 2.25 9.3 6.7l4.45 1.3-4.45 1.3L8 13.75 6.7 9.3 2.25 8l4.45-1.3Z"/>',
    globe: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25Z"/>',
  };
  return `<span class="settings-icon"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${shapes[name]}</svg></span>`;
}

function modelLabel(model: SettingsView["model"]): string {
  const label = model?.label;
  return !label || label === "no model" ? "None" : label === "cursor account" ? "Cursor account" : label === "model ready" ? "Connected" : label === "fixture model" ? "Test model" : label;
}

function remoteLabel(view: SettingsView): string {
  return view.settings?.remoteMcp ? view.relay?.paired ? "On, paired" : "On, not paired" : "Off";
}

export function settingsIndex(view: SettingsView): string {
  const mac = view.helper?.platform === "darwin";
  const summaries = [
    "Heal policy, waits",
    mac ? view.helper?.accessibility ? "Accessibility allowed" : "Optional for native apps" : "Mac only",
    remoteLabel(view),
    `${view.sites.length} ${view.sites.length === 1 ? "site" : "sites"} from your Chrome`,
    modelLabel(view.model),
  ];
  return `<header class="pane-bar"><button id="sidebar-toggle" type="button" aria-label="Show sidebar" aria-haspopup="dialog" aria-controls="sidebar-dialog">${shellIcon("sidebar")}</button><div><h1>Settings</h1><p class="settings-subtitle">Grouped rows save on change</p></div></header>
    <nav class="settings-index" aria-label="Settings sections">${sections.map(([id, glyph, title], i) => `<a href="#set-${id}" data-settings-jump="${id}"${i === 0 ? ' aria-current="true"' : ""}>${icon(glyph)}<span><b>${title}</b><span class="settings-subtitle">${esc(summaries[i])}</span></span></a>`).join("")}</nav>`;
}

function row(copy: string, control: string, glyph = ""): string {
  return `<div class="settings-row">${glyph ? icon(glyph) : ""}<div class="settings-copy">${copy}</div><div class="settings-control">${control}</div></div>`;
}

function group(id: string, title: string, rows: string): string {
  return `<h3 class="settings-heading" id="set-${id}" tabindex="-1">${title}</h3><div class="settings-group">${rows}</div>`;
}

export function settingsScreen(view: SettingsView, advanced: string): string {
  const settings = view.settings || {};
  const mac = view.helper?.platform === "darwin";
  const helper = view.helper?.label === "helper available";
  const accessibility = mac && helper ? view.helper?.accessibility ? "Allowed" : "Not allowed" : mac ? "Helper unavailable" : "Mac only";
  const wait = Math.round((settings.actTimeoutMs ?? 7_200_000) / 60_000);
  const waits = [...new Set([30, 60, 120, 480, wait])].sort((a, b) => a - b);
  const sites = view.sites.map((site) => row(
    `<b>${esc(site.origin.replace(/^https?:\/\//, ""))}</b><p>${site.signedIn === false ? "Needs sign-in." : site.lastProbeLabel ? `Last checked ${esc(site.lastProbeLabel)}.` : "Saved login."} Bao reads this site's login only.</p>`,
    `<button type="button" data-remove="${htmlEsc(controlKey(site.origin))}" aria-label="Remove the ${esc(site.origin)} login">Remove…</button>`, "globe")).join("");
  return `<section id="settings" aria-label="Settings">
    ${group("runs", "Runs and heals", row(
      `<span id="heal-label">When a page changes</span><p>Heal it finds the moved button and keeps going. Ask me stops and shows you first.</p>`,
      `<fieldset class="settings-segmented" aria-labelledby="heal-label"><legend class="settings-sr">When a page changes</legend>${[["auto", "Heal it"], ["approve", "Ask me"]].map(([value, label]) => `<input type="radio" name="heal" id="heal-${value}" value="${value}" data-setting="heal"${(settings.heal || "auto") === value ? " checked" : ""}><label for="heal-${value}">${label}</label>`).join("")}</fieldset>`)
      + row(`<label for="promote-after">Keep a heal after</label><p>Clean runs with the new target before Bao keeps it for good.</p>`, `<input id="promote-after" data-setting="promoteAfter" type="number" required min="1" max="20" value="${settings.promoteAfter ?? 3}" aria-describedby="keep-unit"><span id="keep-unit">runs</span>`)
      + row(`<label for="act-minutes">Wait for you up to</label><p>How long a run waits for a code, a login, or a button only you press.</p>`, `<select id="act-minutes" data-setting="actTimeoutMin">${waits.map((minutes) => `<option value="${minutes}"${minutes === wait ? " selected" : ""}>${minutes < 60 || minutes % 60 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`}</option>`).join("")}<option value="custom">Other…</option></select><input id="act-custom" data-setting="actTimeoutMin" type="number" required min="1" max="1440" value="${wait}" aria-label="Wait in minutes" hidden>`))}
    ${group("perm", "Mac permissions", row(
      `<b>Accessibility</b><p>${mac ? "Lets Bao's helper click and type in native Mac apps. Chrome agents do not need it." : "Native Mac app control uses this permission on macOS. It does not apply on Linux."}</p>`,
      `<span class="settings-permission${view.helper?.accessibility && mac ? " allowed" : ""}">${view.helper?.accessibility && mac ? "✓ " : ""}${accessibility}</span>`, "hand")
      + row(`<b>Screen Recording</b><p>${mac ? "Lets Bao's helper capture app windows for pictures and native-app control. Chrome screenshots do not need it." : "Mac window capture uses this permission on macOS. It does not apply on Linux."}</p>`,
        `<span class="settings-permission">${mac ? "Not checked" : "Mac only"}</span>${mac ? '<a class="button" href="x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture">Open System Settings</a>' : ""}`, "eye"))}
    ${group("remote", "Remote access", row(
      `<label id="remote-label" for="remote-mcp">Let AI agents run my workflows</label><p id="remote-help">An agent on another device can ask to run a workflow on this ${mac ? "Mac" : "computer"}. Off until you turn it on.</p>`,
      `<span id="remote-state">${remoteLabel(view)}</span><input class="settings-switch" id="remote-mcp" type="checkbox" role="switch" data-setting="remoteMcp" aria-describedby="remote-help remote-state"${settings.remoteMcp ? " checked" : ""}>`)
      + row(`<b>Connect another device</b><p id="relay-status">${view.relay?.paired ? "Connected. Revoke to disconnect this computer." : "Not paired. Enter a pairing code from your other device."}</p>`, `<div class="settings-pairing"><label>Pairing code <input id="relay-code" data-settings-draft type="text" autocomplete="off" spellcheck="false"></label><div class="row"><button id="relay-pair" type="button">Pair</button><button id="relay-revoke" type="button"${view.relay?.paired ? "" : " disabled"}>Revoke</button></div></div>`))}
    ${group("logins", "Logins", sites + row(`<p>Bring in one site's login from your Chrome, so runs start signed in.</p>`, `<button type="button" data-screen="logins">Import a login…</button>`))}
    ${group("ai", "AI help", row(`<b>Use AI to suggest heals</b><p>Only when a page changes. Saved steps run without AI.</p>`, `<span id="settings-model">${esc(modelLabel(view.model))}</span>`))}
    <p id="settings-feedback" role="status"></p>
    <details class="settings-advanced" id="settings-advanced"><summary>Technical details</summary><p class="quiet">Engine and window choices use the Save buttons below. Sync and remote pairing details save when you press Pair. Other settings save as you change them.</p>${advanced}</details>
  </section>`;
}
