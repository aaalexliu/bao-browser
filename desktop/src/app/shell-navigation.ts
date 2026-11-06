export const shellPlaces = [
  { id: "runs", label: "Runs", screen: "runs", icon: "runs" },
  { id: "workflows", label: "Workflows", screen: "library", icon: "library" },
  { id: "settings", label: "Settings", screen: "settings", icon: "settings" },
] as const;

export type ShellPlace = typeof shellPlaces[number]["id"];

export const shellScreens = {
  runs: { place: "runs", label: "Runs", description: "Saved runs and their results" },
  live: { place: "runs", label: "Live", description: "The current session on this Mac" },
  heals: { place: "runs", label: "Heals", description: "Review proposed target changes" },
  library: { place: "workflows", label: "Library", description: "Workflows you can run again" },
  capture: { place: "workflows", label: "Capture", description: "Record a browser workflow" },
  teach: { place: "workflows", label: "Teach", description: "Name and review steps as you record" },
  replay: { place: "workflows", label: "Replay", description: "Choose a workflow and its inputs" },
  settings: { place: "settings", label: "Settings", description: "Preferences, permissions, and sync" },
  logins: { place: "settings", label: "Logins", description: "Saved sites and sign-in sessions" },
} as const satisfies Record<string, { place: ShellPlace; label: string; description: string }>;

const detailParents = { run: "runs", workflow: "library", import: "library" } as const;
export type ShellScreen = keyof typeof shellScreens;
export type Screen = ShellScreen | keyof typeof detailParents;

export function shellScreen(screen: Screen): ShellScreen {
  return screen in detailParents ? detailParents[screen as keyof typeof detailParents] : screen as ShellScreen;
}
