// Page class before a heal. Deterministic: DOM, iframe srcs, vendor
// headers and cookies, title and text. No model call.
// bot_wall and login_wall stop the run. clutter is dismissed once.
// changed is the only class that may heal.

export type PageClassName = "bot_wall" | "login_wall" | "clutter" | "changed";

export interface PageEvidence {
  source: "dom" | "iframe" | "header" | "cookie" | "title" | "text" | "status" | "url";
  detail: string;
}

export interface CloseControl {
  text?: string;
  testId?: string;
  role?: string;
  name?: string;
}

export interface PageResponse {
  url?: string;
  method?: string;
  status?: number;
  headers?: { name: string; value: string }[];
}

export interface PageNode {
  role?: string;
  text?: string;
  name?: string;
  label?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
}

export interface PageSignals {
  url?: string;
  /** Where the run opened. A member URL that later shows a login URL is a wall. */
  startedUrl?: string;
  title?: string;
  texts?: string[];
  markers?: string[];
  iframeSrcs?: string[];
  cookies?: { name: string }[];
  responses?: PageResponse[];
  hasPassword?: boolean;
  /** The recording already has a password field. */
  recordedPassword?: boolean;
  /** The recording is a login flow, so a login page is expected. */
  recordedLogin?: boolean;
  nodes?: PageNode[];
  closes?: CloseControl[];
  /** Visible challenge frames. An ad iframe with no box is not a widget. */
  widgets?: { src?: string; w: number; h: number }[];
  /** The recorded target is on this page. A wall also requires it to be missing. */
  targetPresent?: boolean;
}

export interface PageClassDecision {
  class: PageClassName;
  reason: string;
  vendor?: string;
  evidence: PageEvidence[];
  dismiss?: CloseControl;
}

export interface PageClassRecord {
  stepId: string;
  at: number;
  class: PageClassName;
  reason: string;
  vendor?: string;
  evidence: PageEvidence[];
  /** Plain line shown when the run stops for a person. */
  line?: string;
  dismiss?: CloseControl;
}

/** Same paths the login probe treats as a login URL. */
const LOGIN_PATH = /(?:^|\/)(login|log-in|signin|sign-in|sign_in|log_in)(?:\.html?)?(?:\/|$)/i;

const HUMAN = /verify you are human|verify you are not a bot|verifying you are not a bot|prove you are human|i['’]?m not a robot|are you a human/i;
const SIGNED_OUT = /signed out|session expired|you are not signed in/i;
const CLOSE_TEXT = /^(accept|accept all|agree|allow|allow all|got it|ok|okay|dismiss|close|not now|no thanks|maybe later|no, thanks|skip|×|✕|✗)$/i;
const CAPTCHA_CONTROL = /captcha|recaptcha|hcaptcha|turnstile|not a robot|verify you are human/i;

const DROP_LABEL = new Set(["www", "m", "app", "member", "login", "usa", "us", "secure", "portal", "my", "id", "auth", "account", "go"]);

export function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (LOGIN_PATH.test(parsed.pathname)) return true;
    return /(?:^|[?&])(login|signin|sign-in)=/i.test(parsed.search);
  } catch {
    return false;
  }
}

/** A short site name. usa.experian.com is Experian. */
export function siteName(urlOrHost: string): string {
  let host = urlOrHost.trim();
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    host = urlOrHost.replace(/^https?:\/\//, "").split("/")[0] || urlOrHost;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || /^\d+(\.\d+){3}$/.test(host) || host.endsWith(".localhost")) return "This page";
  const labels = host.split(".").filter(Boolean);
  const suffix2 = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.nz"]);
  const cut = labels.length >= 3 && suffix2.has(labels.slice(-2).join(".")) ? 2 : 1;
  const name = labels.slice(0, Math.max(1, labels.length - cut));
  while (name.length > 1 && DROP_LABEL.has(name[0] || "")) name.shift();
  const raw = name[0] || labels[0] || host;
  return raw.split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function recordingExpectsLogin(steps: { action?: string; identity?: PageNode }[]): { password: boolean; login: boolean } {
  const password = steps.some((step) => isPasswordIdentity(step.identity));
  const login = steps.some((step) => step.action === "login");
  return { password, login };
}

export function isPasswordIdentity(node: PageNode | undefined): boolean {
  if (!node) return false;
  if (node.role === "password" || node.nameAttr === "password" || node.id === "password") return true;
  const named = `${node.name || ""} ${node.label || ""}`;
  return node.role === "textbox" && /password/i.test(named);
}

export function classifyPage(input: PageSignals): PageClassDecision {
  const bot = botWall(input);
  if (bot) return bot;
  const login = loginWall(input);
  if (login) return login;
  const clutter = clutterWall(input);
  if (clutter) return clutter;
  return { class: "changed", reason: "page changed", evidence: [] };
}

function botWall(input: PageSignals): PageClassDecision | undefined {
  if (input.targetPresent === true) return undefined;
  const title = input.title || "";
  const texts = shortTexts(input);
  const markers = (input.markers || []).join("\n");
  const iframes = input.iframeSrcs || [];
  const vendors: { name: string; hit: PageEvidence | undefined }[] = [
    { name: "reCAPTCHA", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /google\.com\/recaptcha|recaptcha\/(?:api|enterprise)|gstatic\.com\/recaptcha/i,
      marker: /g-recaptcha|grecaptcha|data-sitekey|\brecaptcha\b/i,
      text: /i['’]?m not a robot/i,
    }) },
    { name: "hCaptcha", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /hcaptcha\.com/i,
      marker: /h-captcha|hcaptcha/i,
      text: /\bhcaptcha\b/i,
    }) },
    { name: "Turnstile", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /challenges\.cloudflare\.com/i,
      marker: /cf-turnstile/i,
      text: /cloudflare turnstile/i,
    }) },
    { name: "Cloudflare", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /cdn-cgi\/challenge|challenges\.cloudflare\.com/i,
      marker: /cf-challenge|cf-browser-verification|challenge-running|challenge-form|cf-error-details/i,
      title: /just a moment|attention required/i,
      text: /checking your browser|enable javascript and cookies to continue|sorry, you have been blocked|cf-browser-verification|performance & security by cloudflare/i,
    }) },
    { name: "Akamai", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /edgesuite\.net|\/akam\//i,
      marker: /akamai/i,
      title: /access denied/i,
      text: /reference\s*#|akamai|edgesuite/i,
    }) },
    { name: "Imperva", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /_incapsula_resource|incapsula|imperva/i,
      marker: /incapsula|imperva/i,
      text: /incapsula incident|request unsuccessful|powered by imperva/i,
    }) },
    { name: "PerimeterX", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /px-cdn\.net|px-cloud\.net|perimeterx/i,
      marker: /px-captcha|perimeterx/i,
      text: /press\s*&\s*hold|access to this page has been denied/i,
    }) },
    { name: "DataDome", hit: vendorHit(input, title, texts, markers, iframes, {
      iframe: /captcha-delivery\.com|datadome\.co/i,
      marker: /datadome/i,
      text: /\bdatadome\b/i,
    }) },
  ];
  for (const vendor of vendors) {
    if (!vendor.hit) continue;
    if (vendor.name === "Akamai" && !/akamai|edgesuite|reference\s*#/i.test(`${title}\n${texts.join("\n")}\n${markers}\n${iframes.join("\n")}`)) continue;
    if (vendor.name === "PerimeterX" && vendor.hit.source === "text" && !/px-|perimeterx|press\s*&\s*hold/i.test(`${markers}\n${iframes.join("\n")}\n${texts.join("\n")}`)) continue;
    return { class: "bot_wall", reason: "bot check", vendor: vendor.name, evidence: [vendor.hit] };
  }
  const human = texts.find((text) => HUMAN.test(text)) || (HUMAN.test(title) ? title : "");
  if (human) return { class: "bot_wall", reason: "bot check", vendor: "captcha", evidence: [{ source: HUMAN.test(title) && !texts.includes(human) ? "title" : "text", detail: clip(human) }] };
  if (/\bcaptcha\b/i.test(title) || texts.some((text) => text.length < 80 && /\bcaptcha\b/i.test(text))) {
    const detail = (/\bcaptcha\b/i.test(title) ? title : texts.find((text) => /\bcaptcha\b/i.test(text)) || title).trim();
    return { class: "bot_wall", reason: "bot check", vendor: "captcha", evidence: [{ source: /\bcaptcha\b/i.test(title) ? "title" : "text", detail: clip(detail) }] };
  }
  const blocked = blockedDocument(input);
  if (blocked) {
    const fromHeader = vendorHeader(blocked.headers || []);
    if (fromHeader) {
      return {
        class: "bot_wall",
        reason: "bot check",
        vendor: fromHeader.vendor,
        evidence: [
          { source: "status", detail: String(blocked.status) },
          { source: "header", detail: `${fromHeader.name}=${clip(fromHeader.value)}` },
        ],
      };
    }
    const cookie = vendorCookie(input.cookies || []);
    if (cookie) {
      return {
        class: "bot_wall",
        reason: "bot check",
        vendor: cookie.vendor,
        evidence: [
          { source: "status", detail: String(blocked.status) },
          { source: "cookie", detail: cookie.name },
        ],
      };
    }
  }
  return undefined;
}

function vendorHit(
  input: PageSignals,
  title: string,
  texts: string[],
  _markers: string,
  _iframes: string[],
  rule: { iframe?: RegExp; marker?: RegExp; title?: RegExp; text?: RegExp },
): PageEvidence | undefined {
  const widget = (input.widgets || []).find((item) => item.w >= 40 && item.h >= 40 && !!item.src && !!rule.iframe?.test(item.src));
  if (widget?.src) return { source: "iframe", detail: clip(widget.src) };
  if (rule.title && rule.title.test(title)) return { source: "title", detail: clip(title) };
  const text = rule.text ? texts.find((item) => rule.text!.test(item)) : undefined;
  if (text) return { source: "text", detail: clip(text) };
  return undefined;
}

function loginWall(input: PageSignals): PageClassDecision | undefined {
  if (input.recordedLogin) return undefined;
  const url = input.url || "";
  const started = input.startedUrl || "";
  const evidence: PageEvidence[] = [];
  const settledLogin = url && isLoginUrl(url) && started && !isLoginUrl(started);
  if (settledLogin) {
    evidence.push({ source: "url", detail: `settled ${clip(url, 180)}` });
    evidence.push({ source: "url", detail: `started ${clip(started, 180)}` });
    const denied = (input.responses || []).find((item) => (item.status === 401 || item.status === 403) && item.url && !samePath(item.url, url));
    if (denied) evidence.push({ source: "status", detail: `${denied.method || "GET"} ${pathnameOf(denied.url || "")} ${denied.status}` });
  }
  // A password field on the URL the run opened is that page. One that shows up
  // after the URL changes, and that the recording never typed, is a signed-out page.
  const password = input.hasPassword && !input.recordedPassword && urlMoved(input);
  if (password) evidence.push({ source: "dom", detail: "password field" });
  const signed = shortTexts(input).find((text) => SIGNED_OUT.test(text));
  if (signed) evidence.push({ source: "text", detail: clip(signed) });
  if (!evidence.length) return undefined;
  return { class: "login_wall", reason: "session expired", evidence };
}

function clutterWall(input: PageSignals): PageClassDecision | undefined {
  const close = pickClose(input);
  if (!close || CAPTCHA_CONTROL.test(`${close.text || ""} ${close.name || ""} ${close.testId || ""}`)) return undefined;
  const blob = `${input.title || ""}\n${shortTexts(input).join("\n")}\n${(input.markers || []).join("\n")}\n${(input.iframeSrcs || []).join("\n")}`;
  const kind = clutterKind(blob, input);
  if (!kind) return undefined;
  return { class: "clutter", reason: kind, evidence: [{ source: "text", detail: kind }], dismiss: close };
}

function clutterKind(blob: string, input: PageSignals): string | undefined {
  if (/cookie|consent|privacy choices/i.test(blob)) return "cookie banner";
  if (/newsletter|subscribe|sign up for (updates|our)|signup/i.test(blob)) return "newsletter";
  if (/interstitial|advertisement|sponsored|close ad|googlesyndication/i.test(blob)) return "ad";
  const chat = /intercom|drift\.com|zdassets|zendesk|hubspot|crisp\.chat|tawk\.to|livechat|chat with us/i.test(blob);
  if (chat && (hasDialog(input) || /chat with us/i.test(blob))) return "chat";
  if (/modal window|\bmodal\b/i.test(blob) || hasDialog(input)) return "modal";
  return undefined;
}

function hasDialog(input: PageSignals): boolean {
  if ((input.nodes || []).some((node) => node.role === "dialog" || node.testId === "overlay" || node.testId === "cookie-banner")) return true;
  return (input.markers || []).some((marker) => /\bdialog\b|\bmodal\b/i.test(marker));
}

function pickClose(input: PageSignals): CloseControl | undefined {
  const listed = input.closes || [];
  const fromNodes = (input.nodes || []).flatMap((node) => {
    const text = (node.text || node.name || node.label || "").replace(/\s+/g, " ").trim();
    if (node.testId === "overlay-close" || node.testId === "accept-cookies" || node.testId === "modal-close") {
      return [{ text, testId: node.testId, role: node.role, name: node.name }];
    }
    if (CLOSE_TEXT.test(text)) return [{ text, testId: node.testId, role: node.role, name: node.name }];
    return [];
  });
  return [...listed, ...fromNodes].find((item) => !CAPTCHA_CONTROL.test(`${item.text || ""} ${item.name || ""}`));
}

function shortTexts(input: PageSignals): string[] {
  const out: string[] = [];
  for (const text of input.texts || []) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) out.push(clean.slice(0, 400));
  }
  for (const node of input.nodes || []) {
    for (const bit of [node.text, node.name, node.label]) {
      const clean = (bit || "").replace(/\s+/g, " ").trim();
      if (clean) out.push(clean.slice(0, 200));
    }
  }
  return out;
}

function blockedDocument(input: PageSignals): PageResponse | undefined {
  const page = input.url || "";
  for (const item of input.responses || []) {
    if (item.status !== 403 && item.status !== 429) continue;
    if (!page || !item.url || samePath(item.url, page)) return item;
  }
  return undefined;
}

function vendorHeader(headers: { name: string; value: string }[]): { vendor: string; name: string; value: string } | undefined {
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = header.value || "";
    if (name === "cf-mitigated" || (name === "server" && /cloudflare/i.test(value))) return { vendor: "Cloudflare", name, value };
    if (/akamai|x-akamai/.test(name) || (name === "server" && /akamai/i.test(value))) return { vendor: "Akamai", name, value };
    if (name === "x-iinfo" || name === "x-cdn" && /imperva|incapsula/i.test(value) || /incap/.test(name)) return { vendor: "Imperva", name, value };
    if (/datadome|^x-dd-/.test(name)) return { vendor: "DataDome", name, value };
    if (/^x-px|^px-/.test(name)) return { vendor: "PerimeterX", name, value };
  }
  return undefined;
}

function vendorCookie(cookies: { name: string }[]): { vendor: string; name: string } | undefined {
  for (const cookie of cookies) {
    const name = cookie.name;
    if (/^(cf_clearance|__cf_bm)$/i.test(name)) return { vendor: "Cloudflare", name };
    if (/^(ak_bmsc|_abck|bm_sz|bm_sv)$/i.test(name)) return { vendor: "Akamai", name };
    if (/^(visid_incap_|incap_ses_|nlbi_)/i.test(name)) return { vendor: "Imperva", name };
    if (/^_px/i.test(name)) return { vendor: "PerimeterX", name };
    if (/^datadome$/i.test(name)) return { vendor: "DataDome", name };
  }
  return undefined;
}

function urlMoved(input: PageSignals): boolean {
  const from = input.startedUrl || "";
  const to = input.url || "";
  if (!from || !to) return false;
  return pathOf(from) !== pathOf(to);
}

function samePath(a: string, b: string): boolean {
  return pathOf(a) === pathOf(b);
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    const cut = url.split("?")[0] || url;
    const slash = cut.indexOf("/", cut.indexOf("//") + 2);
    return slash >= 0 ? cut.slice(slash) : cut;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0] || url;
  }
}

function clip(value: string, max = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export interface PageMarkerDump {
  url: string;
  title: string;
  texts: string[];
  iframeSrcs: string[];
  markers: string[];
  widgets: { src?: string; w: number; h: number }[];
  hasPassword: boolean;
  closes: CloseControl[];
}

/** Runs in the page. No Node imports. Playwright serializes this function. */
export function readPageMarkers(): PageMarkerDump {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  const closeText = /^(accept|accept all|agree|allow|allow all|got it|ok|okay|dismiss|close|not now|no thanks|maybe later|no, thanks|skip|×|✕|✗)$/i;
  const captchaControl = /captcha|recaptcha|hcaptcha|turnstile|not a robot|verify you are human/i;
  const iframeSrcs: string[] = [];
  const widgets: { src?: string; w: number; h: number }[] = [];
  document.querySelectorAll("iframe, frame").forEach((el) => {
    const src = el.getAttribute("src") || "";
    if (!src) return;
    iframeSrcs.push(src.slice(0, 300));
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const hidden = style.display === "none" || style.visibility === "hidden" || el.getAttribute("aria-hidden") === "true";
    if (!hidden && rect.width >= 40 && rect.height >= 40) widgets.push({ src: src.slice(0, 300), w: Math.round(rect.width), h: Math.round(rect.height) });
  });
  const markers: string[] = [];
  const interesting = /recaptcha|hcaptcha|turnstile|cf-|challenge|captcha|incapsula|imperva|datadome|px-captcha|g-recaptcha|h-captcha|akamai|modal|dialog|cookie|intercom|consent/i;
  document.querySelectorAll("[id], [class], [data-testid], [data-sitekey]").forEach((el) => {
    const blob = `${el.id} ${el.getAttribute("class") || ""} ${el.getAttribute("data-testid") || ""} ${el.hasAttribute("data-sitekey") ? "data-sitekey" : ""}`.replace(/\s+/g, " ").trim();
    if (blob && interesting.test(blob)) markers.push(blob.slice(0, 180));
  });
  const body = norm(document.body?.innerText || "").slice(0, 1200);
  const closes: CloseControl[] = [];
  document.querySelectorAll("button, a, [role=button], p, span").forEach((el) => {
    if (closes.length >= 8) return;
    const own = el.childElementCount === 0 ? norm(el.textContent || "") : "";
    const label = norm(el.getAttribute("aria-label") || own).slice(0, 40);
    if (!label || !closeText.test(label)) return;
    if (captchaControl.test(label)) return;
    const testId = el.getAttribute("data-testid") || undefined;
    closes.push({ text: label, testId, role: el.getAttribute("role") || el.tagName.toLowerCase(), name: el.getAttribute("aria-label") || undefined });
  });
  return {
    url: location.href,
    title: document.title,
    texts: body ? [body] : [],
    iframeSrcs: iframeSrcs.slice(0, 40),
    markers: markers.slice(0, 40),
    widgets: widgets.slice(0, 12),
    hasPassword: !!document.querySelector("input[type=password]"),
    closes,
  };
}

/**
 * Clicks a known close control in the page. Refuses captcha and challenge
 * controls. Returns whether something was clicked.
 */
/** A full-page ad vignette is not the recorded control. Small ad slots stay. */
export function dismissCoveringAds(): void {
  if (location.hash === "#google_vignette") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  document.querySelectorAll("ins.adsbygoogle, iframe, [data-vignette-loaded], .google-auto-placed").forEach((el) => {
    const box = el.getBoundingClientRect();
    const id = el.id || "";
    const src = el instanceof HTMLIFrameElement ? el.src : "";
    const title = el.getAttribute("title") || "";
    const vignette = el.hasAttribute("data-vignette-loaded")
      || el.classList.contains("adsbygoogle")
      || el.classList.contains("google-auto-placed")
      || /vignette|aswift|googlesyndication|doubleclick|googleads/i.test(`${id} ${src} ${title}`);
    if (!vignette && (el.tagName !== "IFRAME" || box.width * box.height < 400 * 240)) return;
    if (!vignette && el.tagName === "IFRAME" && title !== "Advertisement") return;
    el.remove();
  });
}

export function clickKnownClose(): boolean {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  const closeText = /^(accept|accept all|agree|allow|allow all|got it|ok|okay|dismiss|close|not now|no thanks|maybe later|no, thanks|skip|×|✕|✗)$/i;
  const captchaControl = /captcha|recaptcha|hcaptcha|turnstile|not a robot|verify you are human/i;
  const nodes = document.querySelectorAll("button, a, [role=button], p, span");
  for (const el of nodes) {
    const own = el.childElementCount === 0 ? norm(el.textContent || "") : "";
    const label = norm(el.getAttribute("aria-label") || own).slice(0, 40);
    if (!label || !closeText.test(label) || captchaControl.test(label)) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (el instanceof HTMLElement) el.click();
    return true;
  }
  return false;
}
