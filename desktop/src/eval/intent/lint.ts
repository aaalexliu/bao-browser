// Deterministic checks in front of the intent judge. A reject here is a bad
// text. The model only scores text that passes.

export interface LintTarget {
  action: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  input?: string;
  /** Captured value that belongs in the param slot, not in the sentence. */
  literal?: string;
}

const GENERIC = new Set([
  "a", "an", "the", "to", "into", "onto", "on", "in", "and", "or", "of", "for",
  "with", "from", "then", "it", "this", "that",
  "click", "type", "press", "open", "do", "tap", "hit",
  "button", "thing", "box", "page", "menu", "around",
]);

const DESTRUCTIVE = new Set(["delete", "clear", "uncheck", "remove", "wipe", "erase", "reset"]);

/** A short reason when the text is rejected, otherwise null. */
export function lintIntent(text: string, target?: LintTarget, secrets: readonly string[] = []): string | null {
  const sentence = text.trim();
  if (!sentence) return "empty";
  if (/\bhelp\b/i.test(sentence)) return "help";
  for (const secret of secrets) {
    if (secret && secret.length >= 3 && sentence.includes(secret)) return "secret";
  }
  if (target?.input && target.literal && sentence.includes(target.literal)) return "literal";
  const verbs = clauseVerbs(sentence);
  if (target && verbs.some((verb) => DESTRUCTIVE.has(verb.toLowerCase()) && !stepDoes(verb, target))) {
    return "destructive";
  }
  const words = contentWords(sentence);
  if (words.length === 0 || words.every((word) => GENERIC.has(word))) return "generic";
  if (target && (target.name || target.label || target.text || target.input) && !namesTarget(sentence, target)) {
    return "target";
  }
  return null;
}

function clauseVerbs(text: string): string[] {
  return text.split(/\band\b/i).map((part) => part.trim().split(/\s+/)[0] || "").filter(Boolean);
}

function stepDoes(verb: string, target: LintTarget): boolean {
  const v = verb.toLowerCase();
  if (v === "uncheck") return target.action === "check";
  const hay = [target.name, target.label, target.text].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(v);
}

function namesTarget(text: string, target: LintTarget): boolean {
  if (target.input && new RegExp(`\\{\\{\\s*${escapeReg(target.input)}\\s*\\}\\}`).test(text)) return true;
  if (target.input && new RegExp(`\\b${escapeReg(target.input)}\\b`, "i").test(text)) return true;
  const names = [target.name, target.label, target.text].filter((item): item is string => !!item && item.length >= 2);
  const lower = text.toLowerCase();
  return names.some((name) => lower.includes(name.toLowerCase()));
}

function contentWords(text: string): string[] {
  return text
    .replace(/\{\{[^}]+\}\}/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PrejudgeInput {
  text: string;
  target?: LintTarget;
  secrets?: readonly string[];
  /** False when the trail recorded no url, value, checked, subtree, or dialog change. */
  effect?: boolean;
}

/**
 * Deterministic checks in front of the LLM judge.
 * Order: missing input, secret literal, step mismatch, step with no effect.
 * A reason means the text is bad. Null means the judge still has to score it.
 */
export function prejudgeLint(input: PrejudgeInput): string | null {
  const text = input.text.trim();
  if (missingInput(text, input.target)) return "missing-input";
  if (secretLiteral(text, input.secrets || [], input.target)) return "secret-literal";
  if (stepMismatch(text, input.target)) return "step-mismatch";
  if (input.effect === false || /\bhelp\b/i.test(text)) return "no-effect";
  return null;
}

/** The sentence names an effect the step does not perform, or it quotes the captured value. */
function stepMismatch(text: string, target?: LintTarget): boolean {
  if (!target || !text) return false;
  const verbs = clauseVerbs(text);
  if (verbs.some((verb) => DESTRUCTIVE.has(verb.toLowerCase()) && !stepDoes(verb, target))) return true;
  return !!target.input && !!target.literal && target.literal.length >= 3 && text.includes(target.literal);
}

function missingInput(text: string, target?: LintTarget): boolean {
  if (!text) return true;
  if (!target) return false;
  if (/\{\{[^}]+\}\}/.test(text)) return false;
  const names = [target.name, target.label, target.text].filter((item): item is string => !!item && item.trim().length >= 2);
  const lower = text.toLowerCase();
  if (names.some((name) => lower.includes(name.toLowerCase()))) return false;
  if (target.input && new RegExp(`\\b${escapeReg(target.input)}\\b`, "i").test(text)) return false;
  return names.length > 0 || !!target.input;
}

function secretLiteral(text: string, secrets: readonly string[], target?: LintTarget): boolean {
  const sentence = text.replace(/\{\{[^}]+\}\}/g, " ");
  for (const secret of secrets) {
    if (secret && secret.length >= 3 && sentence.includes(secret)) return true;
  }
  if (target?.literal && looksSecret(target.literal) && sentence.includes(target.literal)) return true;
  if (/\bpin-\d{3,}\b/i.test(sentence)) return true;
  const tokens = sentence.split(/[^A-Za-z0-9!@#$%^&*]+/);
  return tokens.some((token) => token.length >= 8 && /[A-Za-z]/.test(token) && /[!@#$%^&*]/.test(token));
}

function looksSecret(value: string): boolean {
  return /\bpin-\d{3,}\b/i.test(value) || (value.length >= 8 && /[A-Za-z]/.test(value) && /[!@#$%^&*]/.test(value));
}
