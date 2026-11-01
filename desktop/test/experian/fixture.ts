// Adapted from the Experian scout's local stand-in. Never contacts Experian.
import { createServer } from "node:https";
import { selfSignedCert } from "../instacart/cert";

export const EXPERIAN_FIXTURE_HOSTS = ["www.experian.com", "usa.experian.com", "credit.test"];

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const header = `<nav><a href="/member">Dashboard</a><a href="/member/credit-report">View full credit report</a><a href="/member/alerts">See alerts</a></nav>`;
const traps = ["Freeze", "Unfreeze", "Lock", "Unlock", "Dispute", "Sign out", "Log out", "Cancel"];
const buttons = traps.map((label) => label === "Unfreeze"
  ? `<form onsubmit="event.preventDefault();fetch('/write', {method:'POST'})"><button type="submit">${label}</button></form>`
  : `<button type="button" onclick="fetch('/write', {method:'POST'})">${label}</button>`).join("");

export async function startExperianFixture() {
  const certificate = selfSignedCert(EXPERIAN_FIXTURE_HOSTS);
  const requests: { host: string; path: string }[] = [];
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const url = new URL(req.url || "/", "https://fixture");
    requests.push({ host, path: url.pathname });
    const send = (title: string, body: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(page(title, body));
    };
    if (url.pathname === "/seed") {
      res.setHeader("set-cookie", ["incap_ses_standin=ok; Path=/; HttpOnly; SameSite=Lax", "sid=standin-session; Path=/; HttpOnly; SameSite=Lax"]);
      send("Signed in (stand-in)", "");
    } else if (url.pathname === "/member/expired") {
      res.writeHead(302, { location: "/login/index?refUrl=%2Fmember" });
      res.end();
    } else if (url.pathname === "/member/account-redirect") {
      res.writeHead(302, { location: "/account" });
      res.end();
    } else if (url.pathname === "/member/bot") {
      send("Request unsuccessful", "<p>Incapsula incident ID: 000000000-0000000000000000</p>", 403);
    } else if (url.pathname === "/") {
      send("Credit Stand-in", '<a href="https://usa.experian.com/member">Member center</a>');
    } else if (url.pathname === "/login/index") {
      send("Sign in", '<form><label>Email <input name="email" autocomplete="username"></label><label>Password <input type="password" autocomplete="current-password"></label></form>');
    } else if (url.pathname.startsWith("/member") && !req.headers.cookie?.includes("incap_ses_standin=ok")) {
      send("Request unsuccessful", "<p>Powered by Imperva. Incapsula incident ID</p>", 403);
    } else if (url.pathname.startsWith("/member") && !req.headers.cookie?.includes("sid=standin-session")) {
      res.writeHead(302, { location: `/login/index?refUrl=${encodeURIComponent(url.pathname)}` });
      res.end();
    } else if (url.pathname === "/member") {
      send("Dashboard", `${header}<p>Your score: 742.</p><a href="https://www.experian.com/">Public site</a><a href="/member/accounts/summary">Accounts summary</a><a href="/member/security-help">Security help</a>${buttons}`);
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return {
    port: address.port, spki: certificate.spki, hosts: EXPERIAN_FIXTURE_HOSTS,
    url: (pathname = "/member", host = "usa.experian.com") => `https://${host}${pathname}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
