export const BROWSER_CHOICES = ["bao", "copy", "current"] as const;
export type BrowserChoice = typeof BROWSER_CHOICES[number];
export const DEFAULT_BROWSER: BrowserChoice = "bao";

export const BROWSER_OPTIONS = {
  bao: {
    label: "Bao profile",
    description: "Uses Bao's separate lasting agent Chrome profile. Imports the site's sign-in from the Chrome profile named by profile, or from the only one. Keeps sign-ins and site data between runs. App Login sites use another profile with a different keychain; sign-ins made in one do not appear in the other. No Mac permissions needed.",
  },
  copy: {
    label: "Fresh Chrome copy",
    description: "Uses a new copy of the Chrome profile named by profile, or of the only one, with its sign-ins and site data. Pick this for a fresh start from Chrome each time. Changes stay in the copy and Bao deletes it when the session ends. Opening some sites can be slow or time out. No Mac permissions needed.",
  },
  current: {
    label: "Running Chrome",
    description: "Uses your open Google Chrome over remote debugging, in a new task tab in a window of the Chrome profile named by profile, or of the only one. Pick this when a site's sign-in does not carry over to the Bao profile. Needs Bao's helper and its Accessibility permission, not Automation or Screen Recording: the helper turns on Chrome's remote-debugging setting and presses Chrome's Allow prompt. Bao closes only its own task tabs and leaves Chrome open.",
  },
} as const satisfies Record<BrowserChoice, { label: string; description: string }>;

export const APP_BROWSER_OPTIONS = {
  bao: {
    label: BROWSER_OPTIONS.bao.label,
    description: "Uses Bao's own Chrome profile with your Login sites. Keeps sign-ins and site data between app runs. Separate from the Bao agent profile; sign-ins do not carry between them because they use different keychains.",
  },
  copy: {
    label: BROWSER_OPTIONS.copy.label,
    description: "Uses a new copy of the Chrome profile picked in Settings, or of the only one, with its sign-ins and site data. Each run starts fresh. The window stays open after the run; the next copy run closes and deletes it. Opening some sites can be slow or time out. No Mac permissions needed.",
  },
  current: {
    label: BROWSER_OPTIONS.current.label,
    description: "Uses your open Google Chrome over remote debugging, in a new tab in a window of the Chrome profile picked in Settings, or of the only one. Needs Bao's helper and its Accessibility permission, not Automation or Screen Recording. The run's tab closes when the run ends; Bao leaves Chrome open.",
  },
} as const;

export const BROWSER_CHOICE_DESCRIPTION = `Browser choice: ${BROWSER_OPTIONS.bao.label} (browser=bao, default) - ${BROWSER_OPTIONS.bao.description} ${BROWSER_OPTIONS.copy.label} (browser=copy) - ${BROWSER_OPTIONS.copy.description} ${BROWSER_OPTIONS.current.label} (browser=current) - ${BROWSER_OPTIONS.current.description}`;

export const PROFILE_DESCRIPTION = "On first open: the Chrome profile folder the session uses, such as Default or Profile 2. browser=bao imports sign-ins from it, browser=copy copies it, and browser=current opens its task tab in a window of it. Omit it when Chrome has one profile. When Chrome has several and the open names none, Bao opens nothing and lists them with names and emails, marks the one picked in Bao Settings, and gives the call to retry. A name Chrome does not have is an error that lists the valid ones.";

export function browserChoice(value: unknown): BrowserChoice {
  if (value === undefined) return DEFAULT_BROWSER;
  if (value === "bao" || value === "copy" || value === "current") return value;
  throw new Error("Choose browser=bao (default), browser=copy, or browser=current.");
}
