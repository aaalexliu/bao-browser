// Structural reads of a v4 step. Shared secret scanning cannot import desktop.

export interface StepLocatorRead {
  kind: string;
  value?: string;
  role?: string;
  name?: string;
}

export interface StepTargetRead {
  locators?: StepLocatorRead[];
  hint?: {
    label?: string;
    nameAttr?: string;
    role?: string;
    surface?: string;
    path?: { role: string; name?: string }[];
    tag?: string;
    inputType?: string;
    autocomplete?: string;
    placeholder?: string;
    id?: string;
  };
}

export interface StepRead {
  action?: string;
  sensitive?: boolean;
  key?: string;
  url?: string;
  input?: string;
  text?: string | { input?: string; literal?: string };
  file?: { input?: string; fromOutput?: string };
  dialog?: { input?: string };
  selection?: { input?: string };
  date?: { input?: string };
  forEach?: { steps?: StepRead[]; over?: { kind?: string; name?: string } };
  target?: StepTargetRead;
}

const TARGET_ACTIONS = new Set(["click", "type", "check", "select", "upload", "drop", "key", "digits", "pickDate", "handoff", "download"]);

export function stepTarget(step: StepRead): StepTargetRead | undefined {
  return step.action && TARGET_ACTIONS.has(step.action) ? step.target : undefined;
}

export function stepInputName(step: StepRead): string | undefined {
  return inputOn(step);
}

function inputOn(step: StepRead): string | undefined {
  switch (step.action) {
    case "type":
    case "select":
    case "digits":
      return step.text && typeof step.text === "object" && "input" in step.text ? step.text.input : undefined;
    case "upload":
    case "drop":
      return step.file && "input" in step.file ? step.file.input : undefined;
    case "click":
      return step.dialog?.input ?? step.selection?.input;
    case "pickDate":
      return step.date?.input;
    case undefined:
    default:
      return undefined;
  }
}

export function stepLiteral(step: StepRead): string | undefined {
  switch (step.action) {
    case "type":
    case "select":
    case "digits":
      return step.text && typeof step.text === "object" && "literal" in step.text ? step.text.literal : undefined;
    case "navigate":
      return step.url;
    case "note":
      return typeof step.text === "string" ? step.text : undefined;
    case undefined:
    default:
      return undefined;
  }
}

/** The literal text a type, select or digits step enters, or the url a navigate step opens. */
export function stepEnteredLiteral(step: StepRead): string | undefined {
  return step.action === "note" ? undefined : stepLiteral(step);
}

export function stepKey(step: StepRead): string | undefined {
  return step.action === "key" && step.key ? step.key : undefined;
}

export function stepSensitive(step: StepRead): boolean {
  return step.action === "type" && step.sensitive === true;
}

export function stepForEach(step: StepRead): StepRead["forEach"] {
  return step.action === "for_each" ? step.forEach : undefined;
}

/** The role a target names: its role locator, else its hint. */
export function targetRole(target: StepTargetRead | undefined): string | undefined {
  const locator = target?.locators?.find((item) => item.kind === "role");
  return locator?.role || target?.hint?.role;
}

/** The accessible name of a target's role locator. */
export function targetName(target: StepTargetRead | undefined): string | undefined {
  return target?.locators?.find((item) => item.kind === "role")?.name;
}

/** A css locator is an element id only when it is a single id selector, not a path that starts with #. */
export function idFromCss(value: string | undefined): string | undefined {
  if (!value?.startsWith("#")) return undefined;
  const body = value.slice(1).replace(/\\(.)/g, "$1");
  if (!body || /[\s>+~.\[:]/.test(body)) return undefined;
  return body;
}

/** The element id a target pins: its hint, else a lone css id selector when no name attribute names the field. */
export function targetElementId(target: StepTargetRead | undefined): string | undefined {
  if (target?.hint?.id) return target.hint.id;
  if (target?.hint?.nameAttr) return undefined;
  const css = target?.locators?.find((item) => item.kind === "css" && idFromCss(item.value));
  return idFromCss(css?.value);
}
