export const BROWSER_CHOICES = ["bao", "copy", "current"] as const;
export type BrowserChoice = typeof BROWSER_CHOICES[number];
export const DEFAULT_BROWSER: BrowserChoice = "bao";

export const BROWSER_OPTIONS = {
  bao: {
    label: "Bao profile",
    description: "Uses Bao's separate lasting agent Chrome profile. Imports the site's sign-in from your selected Chrome profile and keeps sign-ins and site data between runs. App Login sites use another profile with a different keychain; sign-ins made in one do not appear in the other. No Mac permissions needed.",
  },
  copy: {
    label: "Fresh Chrome copy",
    description: "Uses a new copy of your selected Chrome profile with its sign-ins and site data. Pick this for a fresh start from Chrome each time. Changes stay in the copy and Bao deletes it when the session ends. Opening some sites can be slow or time out. No Mac permissions needed.",
  },
  current: {
    label: "Running Chrome",
    description: "Uses your open Google Chrome and its current sign-ins in a new task tab. Pick this to use your live Chrome session. Needs Bao's helper and its Accessibility permission, not Automation or Screen Recording. Bao leaves Chrome open.",
  },
} as const satisfies Record<BrowserChoice, { label: string; description: string }>;

export const APP_BROWSER_OPTIONS = {
  ...BROWSER_OPTIONS,
  bao: {
    label: BROWSER_OPTIONS.bao.label,
    description: "Uses Bao's own Chrome profile with your Login sites. Keeps sign-ins and site data between app runs. Separate from the Bao agent profile; sign-ins do not carry between them because they use different keychains.",
  },
  copy: {
    label: BROWSER_OPTIONS.copy.label,
    description: "Uses a new copy of your selected Chrome profile with its sign-ins and site data. Each run starts fresh. The window stays open after the run; the next copy run closes and deletes it. Opening some sites can be slow or time out. No Mac permissions needed.",
  },
} as const;

export const BROWSER_CHOICE_DESCRIPTION = `Browser choice: ${BROWSER_OPTIONS.bao.label} (browser=bao, default) - ${BROWSER_OPTIONS.bao.description} ${BROWSER_OPTIONS.copy.label} (browser=copy) - ${BROWSER_OPTIONS.copy.description} ${BROWSER_OPTIONS.current.label} (browser=current) - ${BROWSER_OPTIONS.current.description}`;

export function browserChoice(value: unknown): BrowserChoice {
  if (value === undefined) return DEFAULT_BROWSER;
  if (value === "bao" || value === "copy" || value === "current") return value;
  throw new Error("Choose browser=bao (default), browser=copy, or browser=current.");
}
