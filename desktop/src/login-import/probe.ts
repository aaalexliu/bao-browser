// Signed-in check after import. The probe waits until the page has settled
// (network idle, and at least five seconds) and then uses the same login_wall
// check as replay. A member URL that settles on a login URL is signed out,
// even when the browser never received an HTTP redirect.

import { classifyPage } from "../v1/page-class";

export interface ProbeObservation {
  finalUrl: string;
  selectorFound: boolean;
  bodyText: string;
  /** The URL the probe opened. Set after the page has settled. */
  startedUrl?: string;
  hasPassword?: boolean;
}

export type ProbeHow = "selector" | "text" | "login-url" | "login-wall";

export interface ProbeConfig {
  selector?: string;
  text?: string;
}

const LOGIN_PATH = /(?:^|\/)(login|log-in|signin|sign-in|sign_in|log_in)(?:\.html?)?(?:\/|$)/i;

export function isLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (LOGIN_PATH.test(parsed.pathname)) return true;
    return /(?:^|[?&])(login|signin|sign-in)=/i.test(parsed.search);
  } catch {
    return false;
  }
}

export function judgeSignedIn(obs: ProbeObservation, config: ProbeConfig): { signedIn: boolean; how: ProbeHow } {
  if (config.selector || config.text) {
    const selectorOk = config.selector ? obs.selectorFound : true;
    const textOk = config.text ? obs.bodyText.includes(config.text) : true;
    return { signedIn: selectorOk && textOk, how: config.selector ? "selector" : "text" };
  }
  const decision = classifyPage({
    url: obs.finalUrl,
    startedUrl: obs.startedUrl,
    texts: obs.bodyText ? [obs.bodyText] : [],
    hasPassword: obs.hasPassword,
    recordedPassword: false,
    recordedLogin: false,
  });
  if (decision.class === "login_wall") return { signedIn: false, how: "login-wall" };
  return { signedIn: !isLoginUrl(obs.finalUrl), how: "login-url" };
}
