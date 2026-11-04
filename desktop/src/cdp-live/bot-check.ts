export function isImpervaHcaptcha(frames: string[]): boolean {
  return frames.some((resource) => {
    try {
      const url = new URL(resource);
      return /^\/_Incapsula_Resource$/i.test(url.pathname)
        && (url.searchParams.has("SWUDNSAI") || url.searchParams.has("CWUDNSAI"));
    } catch {
      return false;
    }
  });
}

/** Runs in the page. No frame access, cookie reads, or challenge interaction. */
export function readImpervaHcaptcha(): boolean {
  const frames = Array.from(document.querySelectorAll("iframe[src]"));
  return isImpervaHcaptcha(frames.map((frame) => (frame as HTMLIFrameElement).src));
}

export const BOT_CHECK_HELPERS = [
  isImpervaHcaptcha,
  { name: "readBotCheck", toString: () => readImpervaHcaptcha.toString() },
];
