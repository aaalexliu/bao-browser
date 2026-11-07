import { redactSavedValue } from "../../../shared/outbound-secrets";
import { STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { redactForRelease, type ReleaseChange } from "./publish";

export interface ImportQuestion {
  name: string;
  type: string;
  label: string;
  required: boolean;
  choices?: string[];
  prompt: string;
  hint: string;
  example?: string;
}

interface InputRow {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  default?: string;
  choices?: string[];
  askOnImport?: boolean;
  example?: string;
}

export function importQuestions(document: unknown): ImportQuestion[] {
  const inputs = (document as { inputs?: InputRow[] }).inputs ?? [];
  return inputs.filter((input) => input.askOnImport === true).map((input) => {
    const onDevice = input.type === "secret" || input.type === "file";
    const example = onDevice ? undefined : input.example || input.default;
    return {
      name: input.name,
      type: input.type,
      label: input.label || input.name,
      required: !onDevice && input.required !== false,
      choices: input.choices,
      prompt: input.label || input.name,
      hint: example ? `For example, ${example}.` : "The sharer asked for this.",
      example,
    };
  });
}

export function missingAnswers(questions: ImportQuestion[], answers: Record<string, unknown>): string[] {
  return questions
    .filter((question) => question.required && !String(answers[question.name] ?? "").trim())
    .map((question) => question.name);
}

const NAME_FIELD = /^(name|fullName|firstName|lastName|author|customer|username)$/i;

export function personalKind(value: string, field = ""): string {
  const text = value.trim();
  if (!text) return "";
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return "email";
  if (text.startsWith("/") || text.startsWith("~/") || /^[A-Za-z]:\\/.test(text) || /(?:\/home\/|\/Users\/|\\Users\\)/.test(text)) return "path";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return "ssn";
  if (/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/.test(text)) return "phone";
  if (/^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+){1,2}$/.test(text)) return "name";
  if (NAME_FIELD.test(field) && /^[A-Z][a-z]+$/.test(text)) return "name";
  return "";
}

export function publicSamples(inputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (/password|secret|cookie|token/i.test(key) || redactSavedValue(value) === STRIPPED_SECRET) continue;
    const kind = personalKind(value, key);
    if (kind === "email" || kind === "path" || kind === "phone" || kind === "ssn" || kind === "card") continue;
    out[key] = value.trim();
  }
  return out;
}

export function prepareImport(document: unknown): { document: unknown; changes: ReleaseChange[]; questions: ImportQuestion[] } {
  const released = redactForRelease(document);
  return { ...released, questions: importQuestions(released.document) };
}

export function applyImportAnswers(document: unknown, answers: Record<string, unknown>): unknown {
  const questions = importQuestions(document);
  const missing = missingAnswers(questions, answers);
  if (missing.length) throw new Error(`answer ${missing.join(", ")}`);
  const doc = structuredClone(document) as { inputs?: InputRow[] };
  for (const input of doc.inputs ?? []) {
    if (input.type === "file") {
      delete input.default;
      continue;
    }
    const answer = answers[input.name];
    if (typeof answer === "string" && answer.trim()) input.default = input.type === "secret" ? answer : answer.trim();
  }
  return doc;
}

export function applyRegistryImportAnswers(document: unknown, answers: Record<string, unknown>): unknown {
  const doc = applyImportAnswers(document, answers) as { inputs?: InputRow[] };
  for (const input of doc.inputs ?? []) {
    if (input.type === "secret" || input.type === "file") delete input.default;
  }
  return doc;
}
