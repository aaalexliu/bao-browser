// Adapted from the Experian scout's local stand-in. Never contacts Experian.
import { createServer as createSecureServer } from "node:https";
import { createServer, type RequestListener } from "node:http";
import { selfSignedCert } from "../instacart/cert";

export const EXPERIAN_FIXTURE_HOSTS = ["www.experian.com", "usa.experian.com", "credit.test", "www.instacart.com"];

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const header = `<nav><a href="/member">Dashboard</a><a href="/member/credit-report">View full credit report</a><a href="/member/alerts">See alerts</a></nav>`;
const traps = ["Freeze", "Unfreeze", "Lock", "Unlock", "Dispute", "Sign out", "Log out", "Cancel"];
const buttons = traps.map((label) => label === "Unfreeze"
  ? `<form action="/member/freeze"><button type="submit">${label}</button></form>`
  : `<button type="button" onclick="fetch('/write', {method:'POST'})">${label}</button>`).join("");

export async function startExperianFixture(options: { loopbackHttp?: boolean } = {}) {
  const certificate = selfSignedCert(EXPERIAN_FIXTURE_HOSTS);
  const requests: { host: string; path: string }[] = [];
  const handler: RequestListener = (req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url || "/", "https://fixture");
    requests.push({ host, path: url.pathname });
    const send = (title: string, body: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(page(title, body));
    };
    if (url.pathname === "/owner/start") {
      res.writeHead(302, { location: url.searchParams.get("check") === "captcha" ? "/owner/check" : "/owner/sign-in" });
      res.end();
    } else if (url.pathname === "/owner/sign-in") {
      send("Sign in", '<form method="post" action="/owner/complete"><label>Email <input name="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>');
    } else if (url.pathname === "/owner/check") {
      send("hCaptcha: verify you are human", '<p>Stand-in human check. No external requests.</p><form method="post" action="/owner/complete"><label><input type="checkbox" required> I am human</label><button>Continue</button></form>');
    } else if (url.pathname === "/owner/complete" && req.method === "POST") {
      // Discard the synthetic owner's form body. Never retain credentials in fixture evidence.
      req.resume();
      res.setHeader("set-cookie", ["incap_ses_standin=ok; Path=/; HttpOnly; SameSite=Lax", "sid=standin-session; Path=/; HttpOnly; SameSite=Lax"]);
      res.writeHead(303, { location: "/member" });
      res.end();
    } else if (url.pathname === "/seed") {
      res.setHeader("set-cookie", ["incap_ses_standin=ok; Path=/; HttpOnly; SameSite=Lax", "sid=standin-session; Path=/; HttpOnly; SameSite=Lax"]);
      send("Signed in (stand-in)", "");
    } else if (url.pathname === "/member/expired") {
      res.writeHead(302, { location: url.searchParams.get("login") || "/login/index?refUrl=%2Fmember" });
      res.end();
    } else if (url.pathname === "/member/account-redirect") {
      res.writeHead(302, { location: "/account" });
      res.end();
    } else if (url.pathname === "/member/off-host-redirect") {
      res.writeHead(302, { location: "https://credit.test/forbidden" });
      res.end();
    } else if (url.pathname === "/member/path-redirect") {
      res.writeHead(302, { location: "/payment-method" });
      res.end();
    } else if (url.pathname === "/member/policy-links") {
      const scroll = url.searchParams.has("scroll") ? `<div style="height:4000px">More member details</div><script>addEventListener('scroll', () => { location.href = '/member/${url.searchParams.get("scroll")}-redirect'; }, {once:true})</script>` : "";
      send("Member links", `<a href="/member/account-redirect">Account details</a><a href="/member/off-host-redirect">External details</a><a href="/member/path-redirect">More details</a><a href="/member/security-help">Security help</a>${scroll}`);
    } else if (url.pathname === "/member/bot") {
      send("Request unsuccessful", "<p>Incapsula incident ID: 000000000-0000000000000000</p>", 403);
    } else if (url.pathname === "/") {
      send("Credit Stand-in", '<a href="https://usa.experian.com/member">Member center</a>');
    } else if (["/login", "/login/index", "/member/login/index", "/signin", "/sign-in"].includes(url.pathname)) {
      send("Sign in", '<form><label>Email <input name="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label></form>');
    } else if (url.pathname.startsWith("/member") && !req.headers.cookie?.includes("incap_ses_standin=ok")) {
      send("Request unsuccessful", "<p>Powered by Imperva. Incapsula incident ID</p>", 403);
    } else if (url.pathname.startsWith("/member") && !req.headers.cookie?.includes("sid=standin-session")) {
      res.writeHead(302, { location: `/login/index?refUrl=${encodeURIComponent(url.pathname)}` });
      res.end();
    } else if (url.pathname === "/member/session-links") {
      const login = encodeURIComponent(url.searchParams.get("login") || "/login");
      const scroll = url.searchParams.get("scroll") === "1" ? `<div style="height:4000px">More member details</div><script>addEventListener('scroll', () => { location.href = '/member/expired?login=${login}'; }, {once:true})</script>` : "";
      send("Member actions", `<a href="/member/expired?login=${login}">Continue</a><form action="/member/expired"><input type="hidden" name="login" value="${decodeURIComponent(login)}"><label>Search <input type="search" name="q"></label><button type="submit">Search</button></form><a href="${decodeURIComponent(login)}">Resume</a><button type="button" data-path="${decodeURIComponent(login)}" onclick="history.pushState({}, '', this.dataset.path)">More details</button>${scroll}`);
    } else if (url.pathname === "/member/action-halts") {
      const mode = url.searchParams.get("mode");
      send("Member actions", mode === "new_target"
        ? `<button type="button" onclick="window.open('/member/security-help')">More details</button>`
        : `<label>Note <input name="note" onfocus="${mode === "credential_field" ? "this.type='password'" : "this.blur()"}"></label>`);
    } else if (url.pathname === "/member") {
      send("Dashboard", `${header}<p>Your score: 742.</p><a href="https://www.experian.com/">Public site</a><a href="/member/accounts/summary">Accounts summary</a><a href="/member/security-help">Security help</a>${buttons}<a href="/member/freeze">Manage freeze</a>`);
    } else if (url.pathname === "/member/freeze") {
      send("Manage credit freeze", '<a href="/member/unfreeze">Unfreeze my credit</a>');
    } else if (url.pathname === "/member/unfreeze") {
      send("Choose a lift", '<form action="/member/unfreeze/review"><label>Duration <input name="duration" value="7 days"></label><button type="submit">Continue</button></form>');
    } else if (url.pathname === "/member/unfreeze/review") {
      send("Review unfreeze", '<form onsubmit="event.preventDefault();fetch(\'/commit-unfreeze\', {method:\'POST\'}).then(() => {document.querySelector(\'main\').innerHTML=\'<h1>Credit unfrozen</h1>\'})"><label>Note <input name="note"></label><button type="submit">Confirm</button></form>');
    } else if (url.pathname === "/commit-unfreeze") {
      send("Done", "Credit unfrozen");
    } else if (url.pathname === "/member/security-help") {
      send("Security help", `${header}<p>Your freeze PIN is stored safely. Learn about security code, verification code, one-time code, two-factor, 2fa, SSO and sign in with Google or sign in with Apple.</p><input type="hidden" name="pin"><input style="display:none" name="otp" aria-label="OTP">`);
    } else if (url.pathname === "/member/verify") {
      send("Verify your identity", '<p>Enter the verification code</p><label>PIN <input name="pin" autocomplete="one-time-code"></label>');
    } else if (url.pathname === "/member/credit-report" || url.pathname === "/member/accounts/summary") {
      send("Credit report", `${header}<h2>Accounts</h2><p>Stand-in Card: Open, current.</p>`);
    } else if (url.pathname === "/member/alerts") {
      send("Alerts", `${header}<p>No new alerts</p>`);
    } else {
      send("Trap", "<p>This path should not load.</p>");
    }
  };
  const server = options.loopbackHttp ? createServer(handler) : createSecureServer({ key: certificate.key, cert: certificate.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return {
    port: address.port, spki: certificate.spki, hosts: EXPERIAN_FIXTURE_HOSTS,
    url: (pathname = "/member", host = "usa.experian.com") => options.loopbackHttp ? `http://127.0.0.1:${address.port}${pathname}` : `https://${host}${pathname}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
