/** Require both the challenge resource and a widget, not an ordinary hCaptcha form or Imperva sensor. */
export function isImpervaHcaptcha(resources: string[], hcaptcha: boolean): boolean {
  if (!hcaptcha) return false;
  return resources.some((resource) => {
    try {
      const url = new URL(resource);
      return /^\/_Incapsula_Resource$/i.test(url.pathname)
        && (url.searchParams.has("SWCGHOEL") || url.searchParams.has("CWUDNSAI"));
    } catch {
      return false;
    }
  });
}

/** Runs in the page. No frame access, cookie reads, or challenge interaction. */
export function readImpervaHcaptcha(): boolean {
  const frames = Array.from(document.querySelectorAll("iframe[src]"));
  const hcaptcha = !!document.querySelector(".h-captcha[data-sitekey]") || frames.some((frame) => {
    try {
      const host = new URL(frame.getAttribute("src") || "", document.baseURI).hostname;
      return host === "hcaptcha.com" || host.endsWith(".hcaptcha.com");
    } catch {
      return false;
    }
  });
  const resources = Array.from(document.querySelectorAll("script[src], iframe[src]"))
    .map((el) => (el as HTMLScriptElement | HTMLIFrameElement).src);
  return isImpervaHcaptcha(resources, hcaptcha);
}

export const BOT_CHECK_HELPERS = [
  isImpervaHcaptcha,
  { name: "readBotCheck", toString: () => readImpervaHcaptcha.toString() },
];
