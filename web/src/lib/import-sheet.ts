// Import questions. The author marks inputs. Personal values are cleared
// and asked again before a copy is saved.

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
  cleared: string;
}

interface InputRow {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  default?: string;
  choices?: string[];
  askOnImport?: boolean;
  cleared?: string;
  example?: string;
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

export function importQuestions(document: unknown): ImportQuestion[] {
  const inputs = (document as { inputs?: InputRow[] }).inputs ?? [];
  const out: ImportQuestion[] = [];
  for (const input of inputs) {
    const cleared = input.cleared || personalKind(input.default || "", input.name);
    const ask = input.askOnImport === true || input.type === "secret" || input.type === "file" || !!cleared;
    if (!ask) continue;
    const copy = questionCopy(input, cleared);
    out.push({
      name: input.name,
      type: copy.type,
      label: input.label || input.name,
      required: input.required !== false && copy.type !== "secret" && copy.type !== "file",
      choices: input.choices,
      cleared,
      prompt: copy.prompt,
      hint: copy.hint,
      example: copy.example,
    });
  }
  return out;
}

export function missingAnswers(questions: ImportQuestion[], answers: Record<string, unknown>): string[] {
  return questions
    .filter((question) => question.required && !String(answers[question.name] ?? "").trim())
    .map((question) => question.name);
}

export function publicSamples(inputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (/password|secret|cookie|token/i.test(key)) continue;
    const kind = personalKind(value, key);
    if (kind === "email" || kind === "path" || kind === "phone" || kind === "ssn" || kind === "card") continue;
    out[key] = value.trim();
  }
  return out;
}

export function prepareImport(document: unknown): { document: unknown; changes: ReleaseChange[]; questions: ImportQuestion[] } {
  const questions = importQuestions(document);
  const released = redactForRelease(document);
  const doc = released.document as { inputs?: InputRow[] };
  const byName = new Map(questions.map((question) => [question.name, question]));
  for (const input of doc.inputs ?? []) {
    const question = byName.get(input.name);
    if (!question) continue;
    if (question.cleared && input.default) {
      released.changes.push({
        path: `inputs.${input.name}`,
        before: input.default,
        after: "",
        reason: question.cleared,
      });
    }
    if (question.cleared) input.cleared = question.cleared;
    if (question.example) input.example = question.example;
    input.askOnImport = true;
    delete input.default;
  }
  return { document: doc, changes: released.changes, questions };
}

export function applyImportAnswers(document: unknown, answers: Record<string, unknown>): unknown {
  const questions = importQuestions(document);
  const missing = missingAnswers(questions, answers);
  if (missing.length) throw new Error(`answer ${missing.join(", ")}`);
  const doc = structuredClone(document) as { inputs?: InputRow[] };
  for (const input of doc.inputs ?? []) {
    delete input.cleared;
    delete input.example;
    if (input.type === "secret" || input.type === "file") {
      delete input.default;
      continue;
    }
    const answer = answers[input.name];
    if (typeof answer !== "string" || !answer.trim()) continue;
    const kind = personalKind(answer, input.name);
    if (kind === "email" || kind === "path" || kind === "phone" || kind === "ssn") delete input.default;
    else input.default = answer.trim();
  }
  return doc;
}

function questionCopy(input: InputRow, cleared: string): { type: string; prompt: string; hint: string; example?: string } {
  const label = input.label || input.name;
  if (input.type === "secret") {
    return { type: "secret", prompt: label, hint: "You enter this on your device. It is not saved here." };
  }
  if (input.type === "file" || cleared === "path") {
    return {
      type: "file",
      prompt: "Which file",
      hint: cleared === "path" ? "The sharer's file was removed." : "You choose this file on your Mac. It is not saved here.",
    };
  }
  if (cleared === "email") return { type: input.type, prompt: "Email to use", hint: "The sharer's email was removed." };
  if (cleared === "name") return { type: input.type, prompt: "Name to use", hint: "The sharer's name was removed." };
  if (cleared === "phone") return { type: input.type, prompt: "Phone to use", hint: "The sharer's phone number was removed." };
  if (cleared === "ssn") return { type: input.type, prompt: "Number to use", hint: "The sharer's number was removed." };
  const sample = input.example || input.default || "";
  const example = sample && !personalKind(sample, input.name) ? sample : "";
  return {
    type: input.type,
    prompt: label,
    hint: example ? `For example, ${example}.` : "The sharer asked for this.",
    example: example || undefined,
  };
}
