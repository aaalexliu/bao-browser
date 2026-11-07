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

export function publicSamples(inputs: Record<string, unknown>, document?: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const secretNames = new Set(((document as { inputs?: InputRow[] } | undefined)?.inputs ?? []).filter((input) => input.type === "secret").map((input) => input.name));
  for (const [key, value] of Object.entries(inputs)) {
    if (secretNames.has(key) || /password|secret|cookie|token/i.test(key)) continue;
    if (typeof value === "string" && value.trim()) out[key] = value;
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
    if (input.type === "secret") continue;
    const answer = answers[input.name];
    if (typeof answer === "string" && answer.trim()) input.default = answer;
  }
  return doc;
}
