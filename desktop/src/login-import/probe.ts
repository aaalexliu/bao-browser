// Signed-in check after import. The default is: did the probe URL end on a
// login URL? A site can instead name a selector or a text fragment.

export interface ProbeObservation {
  finalUrl: string;
  selectorFound: boolean;
  bodyText: string;
}

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

export function judgeSignedIn(obs: ProbeObservation, config: ProbeConfig): { signedIn: boolean; how: "selector" | "text" | "login-url" } {
  if (config.selector || config.text) {
    const selectorOk = config.selector ? obs.selectorFound : true;
    const textOk = config.text ? obs.bodyText.includes(config.text) : true;
    return { signedIn: selectorOk && textOk, how: config.selector ? "selector" : "text" };
  }
  return { signedIn: !isLoginUrl(obs.finalUrl), how: "login-url" };
}
