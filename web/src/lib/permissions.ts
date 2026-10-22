// What a marketplace listing can do, shown before the first run.
// A confirm or submit step defaults the listing to Always ask.

export interface PermissionInput {
  name: string;
  label: string;
  type: string;
  secret: boolean;
}

export interface PermissionPreview {
  sites: string[];
  inputs: PermissionInput[];
  driver: "browser" | "computer-use" | "browser and computer-use";
  confirm: boolean;
  submit: boolean;
  trust: "ask" | "allow";
}

interface StepLike {
  action?: string;
  label?: string;
  surface?: string;
  gate?: string;
  value?: string;
  identity?: { surface?: string; name?: string; text?: string };
}

interface DocLike {
  startUrl?: string;
  inputs?: { name?: string; label?: string; type?: string }[];
  steps?: StepLike[];
}

export function permissionPreview(document: unknown): PermissionPreview {
  const doc = document && typeof document === "object" ? document as DocLike : {};
  const steps = doc.steps ?? [];
  let browser = false;
  let computer = false;
  let confirm = false;
  let submit = false;
  for (const step of steps) {
    const surface = step.surface || step.identity?.surface || "dom";
    if (surface === "dom") browser = true;
    else computer = true;
    const hit = consequentialStep(step);
    if (hit.confirm) confirm = true;
    if (hit.submit) submit = true;
  }
  if (!browser && !computer && /^https?:\/\//i.test(doc.startUrl || "")) browser = true;
  const driver = browser && computer
    ? "browser and computer-use"
    : computer
      ? "computer-use"
      : "browser";
  return {
    sites: visitOrigins(doc),
    inputs: (doc.inputs ?? []).filter((input) => input.name).map((input) => ({
      name: String(input.name),
      label: input.label || String(input.name),
      type: input.type || "text",
      secret: input.type === "secret",
    })),
    driver,
    confirm,
    submit,
    trust: confirm || submit ? "ask" : "allow",
  };
}

export function driverLabel(driver: PermissionPreview["driver"]): string {
  if (driver === "computer-use") return "Computer use";
  if (driver === "browser and computer-use") return "Browser and computer use";
  return "Browser";
}

export function consequentialStep(step: StepLike): { confirm: boolean; submit: boolean } {
  const text = `${step.label || ""} ${step.identity?.name || ""} ${step.identity?.text || ""} ${step.value || ""}`;
  return {
    confirm: step.action === "confirm" || step.gate === "confirm",
    submit: /\bsubmit\b/i.test(text),
  };
}

export function consequentialCopy(preview: Pick<PermissionPreview, "confirm" | "submit">): string {
  if (preview.confirm && preview.submit) return "Can press confirm and submit. Always ask.";
  if (preview.confirm) return "Can press confirm. Always ask.";
  if (preview.submit) return "Can press submit. Always ask.";
  return "Does not press confirm or submit.";
}

function visitOrigins(doc: DocLike): string[] {
  const origins = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
    try {
      const url = new URL(value);
      if (url.hostname) origins.add(url.origin);
    } catch {
      /* skip a step value that is not a url */
    }
  };
  add(doc.startUrl);
  for (const step of doc.steps ?? []) add(step.value);
  return [...origins].sort();
}
