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
  };
}

export interface StepIdentityRead {
  surface: string;
  role: string;
  name?: string;
  text?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  placeholder?: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
  label?: string;
  cssPath?: string;
  xpath?: string;
  path: { role: string; name?: string }[];
}

export interface StepRead {
  action?: string;
  sensitive?: boolean;
  key?: string;
  url?: string;
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
  const named = inputOn(step);
  if (named) return named;
  const raw = (step as { input?: unknown }).input;
  return typeof raw === "string" ? raw : undefined;
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
    default:
      return undefined;
  }
}

export function stepValueTemplate(step: StepRead): string | undefined {
  const literal = stepLiteral(step);
  if (literal !== undefined && step.action !== "navigate" && step.action !== "note") return literal;
  const input = stepInputName(step);
  if (input && step.action !== "click") return `{{${input}}}`;
  if (step.action === "click" && step.dialog) return `{{${step.dialog.input}}}`;
  if (step.action === "navigate") return step.url;
  return undefined;
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

export function queryFromTarget(target: StepTargetRead | undefined): StepIdentityRead | undefined {
  if (!target) return undefined;
  const role = target.locators?.find((item) => item.kind === "role");
  const text = target.locators?.find((item) => item.kind === "text");
  const testid = target.locators?.find((item) => item.kind === "testid");
  const css = target.locators?.find((item) => item.kind === "css");
  const xpath = target.locators?.find((item) => item.kind === "xpath");
  const id = css?.kind === "css" && css.value?.startsWith("#") ? css.value.slice(1).replace(/\\(.)/g, "$1") : undefined;
  return {
    surface: target.hint?.surface ?? "dom",
    role: (role?.kind === "role" ? role.role : target.hint?.role) || "unknown",
    name: role?.kind === "role" ? role.name : undefined,
    text: text?.kind === "text" ? text.value : undefined,
    testId: testid?.kind === "testid" ? testid.value : undefined,
    cssPath: css?.kind === "css" ? css.value : undefined,
    xpath: xpath?.kind === "xpath" ? xpath.value : undefined,
    label: target.hint?.label,
    nameAttr: target.hint?.nameAttr,
    tag: target.hint?.tag,
    inputType: target.hint?.inputType,
    autocomplete: target.hint?.autocomplete,
    placeholder: target.hint?.placeholder,
    id,
    path: target.hint?.path ?? [],
  };
}

export function stepQuery(step: StepRead): StepIdentityRead | undefined {
  return queryFromTarget(stepTarget(step));
}
