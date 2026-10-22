// Extract, for-each, and workflow outputs.
// Version 3 is this module's document version. Version 2 workflows load
// unchanged. A document gains version 3 only when it uses these steps.
//
// Benchmarks this shape is held to:
// Browserflow scrape (element or list, Next until gone),
// Axiom "get data from a webpage" (columns plus pagination),
// Bardeen scraper (click one row, siblings become the list, name or drop columns),
// Playwright locators (role, text, test id, css, xpath, in that order).

import type { ReplayArgs, StepLocator, WorkflowInput, WorkflowStep, WorkflowV2 } from "./schema";

export const DATA_STEPS_VERSION = 3;

export type ColumnType = "text" | "number" | "url";
export type ColumnRead = "text" | "href" | "src" | "value" | "title" | "rating";

export interface ExtractColumn {
  name: string;
  label?: string;
  type: ColumnType;
  read: ColumnRead;
  locators: StepLocator[];
  dropped?: boolean;
}

export interface ListPagination {
  next: StepLocator[];
  maxPages: number;
}

export interface ExtractSpec {
  mode: "element" | "list";
  locators: StepLocator[];
  columns: ExtractColumn[];
  as: string;
  pagination?: ListPagination;
}

export interface ForEachSpec {
  over: { kind: "extract"; name: string } | { kind: "input"; name: string };
  steps: WorkflowStep[];
}

export interface OutputColumn {
  name: string;
  type: ColumnType;
}

export interface WorkflowOutput {
  name: string;
  label?: string;
  type: "table" | "text" | "number";
  from: string;
  columns?: OutputColumn[];
}

export interface OutputTable {
  name: string;
  label?: string;
  type: "table";
  columns: OutputColumn[];
  rows: Record<string, string>[];
}

export interface OutputScalar {
  name: string;
  label?: string;
  type: "text" | "number";
  value: string | number;
}

export type OutputValue = OutputTable | OutputScalar;

export interface ListCapture {
  headers?: string[];
  rows: Record<string, string>[];
  locators?: StepLocator[];
  columns?: ExtractColumn[];
  pagination?: ListPagination;
  as?: string;
}

export interface DataEvent {
  id?: string;
  op: string;
  value?: string;
  sensitive?: boolean;
  parameter?: string;
  list?: ListCapture;
  extract?: ExtractSpec;
  identity?: { text?: string; name?: string; role?: string };
}

export interface PageColumn {
  id: string;
  name: string;
  read: string;
  type: string;
  locators: StepLocator[];
  samples: string[];
}

export interface PageProposal {
  mode: "element" | "list";
  count: number;
  locators: StepLocator[];
  columns: PageColumn[];
  next?: StepLocator[];
  error?: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const READS = new Set(["text", "href", "src", "value", "title", "rating"]);
const COL_TYPES = new Set(["text", "number", "url"]);

export function workflowVersionError(version: number): string | undefined {
  if (version !== 2 && version !== DATA_STEPS_VERSION) return "version";
  return undefined;
}

export function documentUsesDataSteps(doc: {
  outputs?: unknown;
  steps?: { action?: string; extract?: unknown; forEach?: unknown }[];
}): boolean {
  if (Array.isArray(doc.outputs) && doc.outputs.length > 0) return true;
  return (doc.steps ?? []).some((step) => step.action === "extract" || step.action === "for_each" || step.extract || step.forEach);
}

/** Version 2 documents stay version 2. Data steps stamp version 3. */
export function migrateDataSteps(doc: WorkflowV2): WorkflowV2 {
  if (!documentUsesDataSteps(doc)) return doc;
  if (doc.version === DATA_STEPS_VERSION) return doc;
  return { ...doc, version: DATA_STEPS_VERSION };
}

export function validateDataSteps(doc: WorkflowV2): string[] {
  const errors: string[] = [];
  const names = new Set(doc.inputs.map((input) => input.name));
  for (const input of doc.inputs) {
    if (input.type === "table" && input.default && (input.default.startsWith("/") || input.default.startsWith("~/"))) {
      errors.push(`table path default ${input.name}`);
    }
  }
  const extracted = new Set<string>();
  doc.steps.forEach((step) => {
    if (step.action === "extract") {
      if (!step.extract) errors.push(`extract ${step.id}`);
      else errors.push(...extractErrors(step.extract, step.id));
      if (step.extract?.as) extracted.add(step.extract.as);
    } else if (step.extract) {
      errors.push(`extract field ${step.id}`);
    }
    if (step.action === "for_each") {
      if (!step.forEach) errors.push(`for_each ${step.id}`);
      else errors.push(...forEachErrors(step.forEach, step.id, names, extracted));
    } else if (step.forEach) {
      errors.push(`for_each field ${step.id}`);
    }
  });
  const outputNames = new Set<string>();
  for (const output of doc.outputs ?? []) {
    if (!NAME_RE.test(output.name)) errors.push(`output name ${output.name}`);
    if (outputNames.has(output.name)) errors.push(`duplicate output ${output.name}`);
    outputNames.add(output.name);
    if (output.type !== "table" && output.type !== "text" && output.type !== "number") errors.push(`output type ${output.name}`);
    if (!output.from) errors.push(`output from ${output.name}`);
    else if (!extracted.has(output.from) && !names.has(output.from)) errors.push(`output source ${output.name}`);
    for (const column of output.columns ?? []) {
      if (!NAME_RE.test(column.name)) errors.push(`output column ${output.name}.${column.name}`);
      if (!COL_TYPES.has(column.type)) errors.push(`output column type ${output.name}.${column.name}`);
    }
  }
  if (documentUsesDataSteps(doc) && doc.version !== DATA_STEPS_VERSION) errors.push("version");
  return errors;
}

function extractErrors(spec: ExtractSpec, id: string): string[] {
  const errors: string[] = [];
  if (spec.mode !== "element" && spec.mode !== "list") errors.push(`extract mode ${id}`);
  if (!spec.locators?.length) errors.push(`extract locators ${id}`);
  if (!NAME_RE.test(spec.as || "")) errors.push(`extract name ${id}`);
  const kept = (spec.columns || []).filter((column) => !column.dropped);
  if (!kept.length) errors.push(`extract columns ${id}`);
  const seen = new Set<string>();
  for (const column of spec.columns || []) {
    if (!NAME_RE.test(column.name)) errors.push(`column name ${id}.${column.name}`);
    if (seen.has(column.name)) errors.push(`duplicate column ${id}.${column.name}`);
    seen.add(column.name);
    if (!READS.has(column.read)) errors.push(`column read ${id}.${column.name}`);
    if (!COL_TYPES.has(column.type)) errors.push(`column type ${id}.${column.name}`);
    if (!column.dropped && !column.locators?.length) errors.push(`column locators ${id}.${column.name}`);
  }
  if (spec.pagination) {
    if (!spec.pagination.next?.length) errors.push(`pagination next ${id}`);
    if (!Number.isInteger(spec.pagination.maxPages) || spec.pagination.maxPages < 1 || spec.pagination.maxPages > 100) {
      errors.push(`pagination pages ${id}`);
    }
  }
  return errors;
}

function forEachErrors(spec: ForEachSpec, id: string, inputs: Set<string>, extracted: Set<string>): string[] {
  const errors: string[] = [];
  if (spec.over?.kind === "input") {
    if (!inputs.has(spec.over.name)) errors.push(`for_each input ${id}`);
  } else if (spec.over?.kind === "extract") {
    if (!extracted.has(spec.over.name)) errors.push(`for_each extract ${id}`);
  } else {
    errors.push(`for_each over ${id}`);
  }
  if (!spec.steps?.length) errors.push(`for_each steps ${id}`);
  spec.steps?.forEach((step, index) => {
    if (step.index !== index) errors.push(`for_each index ${id}.${step.id}`);
    if (step.action === "for_each" || step.action === "extract") errors.push(`nested ${step.action} ${id}`);
    if (step.value && step.value.startsWith("/") && !step.value.includes("{{")) errors.push(`path baked into ${step.id}`);
  });
  return errors;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows = csvRows(text).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((cell, index) => sanitizeName(cell, index));
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  });
}

export function parseTable(value: unknown): Record<string, string>[] {
  if (Array.isArray(value)) {
    return value.flatMap((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return [];
      const record: Record<string, string> = {};
      for (const [key, cell] of Object.entries(row as Record<string, unknown>)) {
        const name = sanitizeName(key, 0);
        if (NAME_RE.test(name)) record[name] = cell == null ? "" : String(cell);
      }
      return [record];
    });
  }
  if (typeof value === "string") return parseCsv(value);
  return [];
}

export function tableToCsv(columns: string[], rows: Record<string, string>[]): string {
  const esc = (value: string) => /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [columns.map(esc).join(",")];
  for (const row of rows) lines.push(columns.map((column) => esc(row[column] ?? "")).join(","));
  return `${lines.join("\n")}\n`;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function sanitizeName(raw: string, index: number): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = /^[A-Za-z]/.test(cleaned) ? cleaned : `col_${index + 1}`;
  return NAME_RE.test(base) ? base : `col_${index + 1}`;
}

export function specFromProposal(
  proposal: PageProposal,
  choices: { names?: Record<string, string>; drop?: string[]; maxPages?: number; as?: string },
): ExtractSpec {
  const drop = new Set(choices.drop ?? []);
  const used = new Set<string>();
  const columns: ExtractColumn[] = proposal.columns.map((column, index) => {
    const requested = choices.names?.[column.id] ?? column.name;
    let name = sanitizeName(requested, index);
    let n = 2;
    const stem = name;
    while (used.has(name)) name = `${stem}_${n++}`;
    used.add(name);
    const read = READS.has(column.read) ? column.read as ColumnRead : "text";
    const type = COL_TYPES.has(column.type) ? column.type as ColumnType : "text";
    return {
      name,
      label: requested.trim() || name,
      type,
      read,
      locators: column.locators,
      dropped: drop.has(column.id) || undefined,
    };
  });
  const maxPages = choices.maxPages ?? 1;
  const spec: ExtractSpec = {
    mode: proposal.mode === "element" ? "element" : "list",
    locators: proposal.locators,
    columns,
    as: sanitizeName(choices.as || "items", 0),
  };
  if (proposal.mode === "list" && proposal.next?.length && maxPages > 1) {
    spec.pagination = { next: proposal.next, maxPages };
  }
  return spec;
}

export function specFromList(list: ListCapture): ExtractSpec {
  const columns = list.columns?.length
    ? list.columns
    : headersOf(list).map((name, index) => ({
      name: sanitizeName(name, index),
      label: name,
      type: "text" as const,
      read: "text" as const,
      locators: [] as StepLocator[],
    }));
  return {
    mode: list.locators?.length ? "list" : "element",
    locators: list.locators ?? [],
    columns,
    as: sanitizeName(list.as || "items", 0),
    pagination: list.pagination,
  };
}

function headersOf(list: ListCapture): string[] {
  if (list.headers?.length) return list.headers;
  const first = list.rows[0];
  return first ? Object.keys(first) : [];
}

export interface CapturedPiece<E, S> {
  events: E[];
  step: S;
}

/**
 * Turn a selected or copied list into extract, and a copied table that is
 * typed row by row into for_each. Same trail, same workflow.
 */
export function applyCapturedData<E extends DataEvent>(
  pieces: CapturedPiece<E, WorkflowStep>[],
  inputs: WorkflowInput[],
): { pieces: CapturedPiece<E, WorkflowStep>[]; outputs?: WorkflowOutput[]; version: 2 | 3 } {
  const touched = pieces.some((piece) => piece.events.some((event) =>
    event.parameter || event.list || event.extract || event.op === "extract" || event.op === "copy" || event.op === "select"));
  if (!touched) return { pieces, version: 2 };
  const next = pieces.map((piece) => ({ events: piece.events, step: { ...piece.step } }));
  parameterize(next, inputs);
  const folded = foldCopiedRows(next, inputs);
  const outputs = outputsFor(folded);
  const data = outputs.length > 0 || folded.some((piece) => piece.step.action === "extract" || piece.step.action === "for_each");
  if (data) pruneInputs(inputs, folded.map((piece) => piece.step));
  return {
    pieces: folded,
    outputs: outputs.length ? outputs : undefined,
    version: data ? DATA_STEPS_VERSION : 2,
  };
}

function parameterize<E extends DataEvent>(pieces: CapturedPiece<E, WorkflowStep>[], inputs: WorkflowInput[]): void {
  for (const piece of pieces) {
    const event = piece.events.find((item) => item.parameter);
    if (!event?.parameter || !NAME_RE.test(event.parameter)) continue;
    if (piece.step.action !== "click") continue;
    const input = addInput(inputs, "text", event.parameter);
    const sample = event.identity?.text || event.identity?.name || "";
    if (sample && !sample.startsWith("/") && !sample.startsWith("~/")) input.default = sample;
    piece.step.selection = { by: "text", input: input.name };
    piece.step.label = `Click {{${input.name}}}`;
    piece.step.heal = "never";
    // The recorded page's URL and heading belong to the sample value.
    delete piece.step.postcondition;
    delete piece.step.expect;
  }
}

function foldCopiedRows<E extends DataEvent>(
  pieces: CapturedPiece<E, WorkflowStep>[],
  inputs: WorkflowInput[],
): CapturedPiece<E, WorkflowStep>[] {
  const out: CapturedPiece<E, WorkflowStep>[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const list = piece.events.map((event) => event.list).find((item) => item && item.rows.length >= 2);
    if (!list) {
      if (piece.step.action === "extract" && piece.step.extract && !piece.step.extract.locators.length) continue;
      out.push(piece);
      continue;
    }
    const rest = pieces.slice(i + 1);
    const cycle = cycleLength(rest, list.rows);
    if (cycle && cycle * list.rows.length <= rest.length) {
      const body = bindBody(rest.slice(0, cycle), list.rows[0]!);
      const repeated = cycle * list.rows.length;
      const same = list.rows.every((row, index) => chunkMatches(rest.slice(index * cycle, (index + 1) * cycle), row));
      if (same && body.length) {
        const input = addInput(inputs, "table", list.as || "rows");
        const events = [piece, ...rest.slice(0, repeated)].flatMap((item) => item.events);
        out.push({
          events,
          step: {
            id: piece.step.id,
            index: 0,
            action: "for_each",
            label: `For each ${input.name}`,
            surface: "dom",
            timeoutMs: 8000,
            heal: "never",
            forEach: { over: { kind: "input", name: input.name }, steps: body },
          },
        });
        i += repeated;
        continue;
      }
    }
    if (piece.step.action === "extract" && piece.step.extract?.locators.length) {
      out.push(piece);
      continue;
    }
    const spec = specFromList(list);
    if (!spec.locators.length) continue;
    out.push({
      events: piece.events,
      step: extractStep(piece.step, spec),
    });
  }
  return out;
}

function cycleLength(pieces: CapturedPiece<DataEvent, WorkflowStep>[], rows: Record<string, string>[]): number | undefined {
  if (rows.length < 2) return undefined;
  const second = firstCell(rows[1]!);
  if (!second) return undefined;
  let seen = false;
  const firstValues = new Set(Object.values(rows[0]!).filter((value) => value));
  for (let i = 0; i < pieces.length; i++) {
    const value = pieces[i]!.events.find((event) => event.value)?.value;
    if (value && firstValues.has(value)) seen = true;
    if (seen && value === second && i > 0) return i;
  }
  return undefined;
}

function chunkMatches(pieces: CapturedPiece<DataEvent, WorkflowStep>[], row: Record<string, string>): boolean {
  const cells = new Set(Object.values(row));
  for (const piece of pieces) {
    const value = piece.events.find((event) => event.op === "type" || event.op === "input")?.value;
    if (value && !cells.has(value)) return false;
  }
  return true;
}

function bindBody(pieces: CapturedPiece<DataEvent, WorkflowStep>[], row: Record<string, string>): WorkflowStep[] {
  const used = new Set<string>();
  return pieces.map((piece, index) => {
    const step: WorkflowStep = { ...piece.step, index, id: `row-${index}` };
    const value = piece.events.find((event) => event.value)?.value;
    const column = value
      ? Object.keys(row).find((name) => row[name] === value && !used.has(name))
      : undefined;
    if (column && step.action === "type") {
      used.add(column);
      const previous = step.input;
      delete step.input;
      step.value = `{{row.${column}}}`;
      step.label = `Type {{row.${column}}}`;
      step.sensitive = piece.events.some((event) => event.sensitive) || undefined;
      rewriteTemplates(step, row);
      if (previous) retargetInput(step, previous, column);
    } else {
      rewriteTemplates(step, row);
    }
    step.heal = "never";
    return step;
  });
}

function retargetInput(step: WorkflowStep, input: string, column: string): void {
  const from = `{{${input}}}`;
  const to = `{{row.${column}}}`;
  const swap = (text: string | undefined): string | undefined => text?.split(from).join(to);
  if (step.postcondition?.match) step.postcondition = { ...step.postcondition, match: swap(step.postcondition.match) || "" };
  if (step.expect?.match) step.expect = { ...step.expect, match: swap(step.expect.match) };
}

function rewriteTemplates(step: WorkflowStep, row: Record<string, string>): void {
  const apply = (text: string | undefined): string | undefined => {
    if (!text) return text;
    return templatize(text, row);
  };
  if (step.postcondition?.match) step.postcondition = { ...step.postcondition, match: apply(step.postcondition.match) || "" };
  if (step.expect?.match) step.expect = { ...step.expect, match: apply(step.expect.match) };
}

function templatize(text: string, row: Record<string, string>): string {
  let out = text;
  const cells = Object.entries(row).filter((entry) => entry[1].length >= 2).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of cells) {
    if (out.includes(value)) out = out.split(value).join(`{{row.${name}}}`);
  }
  return out;
}

function firstCell(row: Record<string, string>): string {
  return Object.values(row).find((value) => value) || "";
}

function extractStep(base: WorkflowStep, spec: ExtractSpec): WorkflowStep {
  return {
    ...base,
    action: "extract",
    label: `Extract ${spec.as}`,
    extract: spec,
    locators: spec.locators,
    heal: "never",
    identity: undefined,
    value: undefined,
    input: undefined,
  };
}

function outputsFor(pieces: CapturedPiece<DataEvent, WorkflowStep>[]): WorkflowOutput[] {
  const outputs: WorkflowOutput[] = [];
  for (const piece of pieces) {
    const spec = piece.step.extract;
    if (piece.step.action !== "extract" || !spec) continue;
    outputs.push({
      name: spec.as,
      type: "table",
      from: spec.as,
      columns: spec.columns.filter((column) => !column.dropped).map((column) => ({ name: column.name, type: column.type })),
    });
  }
  return outputs;
}

function addInput(inputs: WorkflowInput[], type: WorkflowInput["type"], hint: string): WorkflowInput {
  let name = sanitizeName(hint, inputs.length);
  let n = 2;
  const stem = name;
  while (inputs.some((item) => item.name === name)) name = `${stem}_${n++}`;
  const input: WorkflowInput = { name, type, required: true, label: hint || name };
  inputs.push(input);
  return input;
}

function pruneInputs(inputs: WorkflowInput[], steps: WorkflowStep[]): void {
  const used = referencedNames(steps);
  for (let i = inputs.length - 1; i >= 0; i--) {
    if (!used.has(inputs[i]!.name)) inputs.splice(i, 1);
  }
}

function referencedNames(steps: WorkflowStep[]): Set<string> {
  const names = new Set<string>();
  const walk = (step: WorkflowStep) => {
    if (step.input) names.add(step.input);
    if (step.selection?.input) names.add(step.selection.input);
    if (step.when?.input) names.add(step.when.input);
    if (step.readBack?.fileInput) names.add(step.readBack.fileInput);
    if (step.forEach?.over.kind === "input") names.add(step.forEach.over.name);
    for (const nested of step.forEach?.steps ?? []) walk(nested);
  };
  for (const step of steps) walk(step);
  return names;
}

export interface ListRead {
  rows: Record<string, string>[];
  nextVisible: boolean;
}

export interface DataDriver {
  readList?(spec: ExtractSpec): Promise<ListRead>;
  activate?(locators: StepLocator[]): Promise<boolean>;
  waitIdle?(timeoutMs: number): Promise<void>;
}

export async function performDataStep(
  step: WorkflowStep,
  args: ReplayArgs,
  tables: Map<string, Record<string, string>[]>,
  driver: DataDriver,
  appending: boolean,
  runNested: (step: WorkflowStep, args: ReplayArgs) => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ ok: true; detail?: string } | { ok: false; reason: string }> {
  if (step.action === "extract" && step.extract) return performExtract(step.extract, tables, driver, appending);
  if (step.action === "for_each" && step.forEach) {
    if (appending) return { ok: false, reason: "nested for_each" };
    return performForEach(step.forEach, args, tables, runNested);
  }
  return { ok: false, reason: "missing data step" };
}

async function performExtract(
  spec: ExtractSpec,
  tables: Map<string, Record<string, string>[]>,
  driver: DataDriver,
  appending: boolean,
): Promise<{ ok: true; detail?: string } | { ok: false; reason: string }> {
  if (!driver.readList) return { ok: false, reason: "this driver cannot extract" };
  const max = spec.pagination?.maxPages ?? 1;
  const all: Record<string, string>[] = [];
  for (let page = 0; page < max; page++) {
    let read: ListRead;
    try {
      read = await driver.readList(spec);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    all.push(...read.rows);
    const more = !!spec.pagination && read.nextVisible && page + 1 < max;
    if (!more) break;
    if (!driver.activate) return { ok: false, reason: "this driver cannot turn the page" };
    const clicked = await driver.activate(spec.pagination!.next);
    if (!clicked) break;
    if (driver.waitIdle) await driver.waitIdle(8000);
  }
  if (!all.length) return { ok: false, reason: "extract found no rows" };
  const prev = appending ? tables.get(spec.as) ?? [] : [];
  tables.set(spec.as, prev.concat(all));
  return { ok: true, detail: `${tables.get(spec.as)!.length} rows` };
}

async function performForEach(
  spec: ForEachSpec,
  args: ReplayArgs,
  tables: Map<string, Record<string, string>[]>,
  runNested: (step: WorkflowStep, args: ReplayArgs) => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ ok: true; detail?: string } | { ok: false; reason: string }> {
  const rows = spec.over.kind === "extract"
    ? tables.get(spec.over.name) ?? []
    : parseTable(args[spec.over.name]);
  if (!rows.length) return { ok: false, reason: "for_each has no rows" };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (const nested of spec.steps) {
      const bound = bindStep(nested, row, i);
      const outcome = await runNested(bound, args);
      if (!outcome.ok) return { ok: false, reason: outcome.reason || `row ${i + 1} failed` };
    }
  }
  return { ok: true, detail: `${rows.length} rows` };
}

export function bindStep(step: WorkflowStep, row: Record<string, string>, index: number): WorkflowStep {
  const copy = structuredClone(step);
  const replace = (text: string): string => text
    .replace(/\{\{\s*row\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_all, name: string) => row[name] ?? "")
    .replace(/\{\{\s*row_index\s*\}\}/g, String(index + 1));
  if (copy.value) copy.value = replace(copy.value);
  if (copy.postcondition?.match) copy.postcondition = { ...copy.postcondition, match: replace(copy.postcondition.match) };
  if (copy.expect?.match) copy.expect = { ...copy.expect, match: replace(copy.expect.match) };
  return copy;
}

export function materializeOutputs(
  workflow: { outputs?: WorkflowOutput[] },
  tables: Map<string, Record<string, string>[]>,
): OutputValue[] | undefined {
  if (!workflow.outputs?.length) return undefined;
  return workflow.outputs.map((output) => {
    const rows = tables.get(output.from) ?? (output.from ? [] : []);
    if (output.type === "number") {
      return { name: output.name, label: output.label, type: "number", value: rows.length };
    }
    if (output.type === "text") {
      const columns = output.columns?.map((column) => column.name) ?? Object.keys(rows[0] ?? {});
      const value = rows.map((row) => columns.map((column) => row[column] ?? "").join(" ")).join("\n");
      return { name: output.name, label: output.label, type: "text", value };
    }
    const columns = output.columns?.length
      ? output.columns
      : Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" as const }));
    return { name: output.name, label: output.label, type: "table" as const, columns, rows };
  });
}

export function captureStartUrl(events: { op?: string; beforeUrl?: string; list?: unknown; extract?: unknown }[], fallback: string): string {
  const data = events.some((event) => event.op === "extract" || event.op === "copy" || event.op === "select" || event.list || event.extract);
  if (!data) return fallback;
  return events.find((event) => event.beforeUrl)?.beforeUrl || fallback;
}

export function outputsHtml(runId: string, outputs: OutputValue[] | undefined): string {
  const tables = (outputs ?? []).filter((item): item is OutputTable => item.type === "table");
  if (!tables.length) return "";
  const blocks = tables.map((table) => {
    const columns = table.columns.map((column) => column.name);
    const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
    const body = table.rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("");
    const csv = `/api/runs/${encodeURIComponent(runId)}/outputs.csv?name=${encodeURIComponent(table.name)}`;
    const json = `/api/runs/${encodeURIComponent(runId)}/outputs.json`;
    return `<section class="output-block" data-output="${escapeHtml(table.name)}" data-rows="${table.rows.length}">
      <header class="output-head">
        <h3>${escapeHtml(table.label || table.name)}</h3>
        <p class="quiet">${table.rows.length} rows</p>
        <p class="output-actions"><a id="output-csv" href="${csv}" download>CSV</a> <a id="output-json" href="${json}" download>JSON</a></p>
      </header>
      <div class="output-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }).join("");
  return `<section id="run-outputs">${blocks}</section>`;
}

export function extractPickerHtml(proposal: PageProposal): string {
  const rows = proposal.columns.map((column) => {
    const sample = column.samples.slice(0, 2).join(" · ");
    return `<tr>
      <td><input type="checkbox" data-col-keep="${escapeHtml(column.id)}" checked aria-label="Keep ${escapeHtml(column.name)}"></td>
      <td><input data-col-name="${escapeHtml(column.id)}" value="${escapeHtml(column.name)}" aria-label="Column name"></td>
      <td class="quiet">${escapeHtml(sample)}</td>
    </tr>`;
  }).join("");
  const pages = proposal.next?.length
    ? `<label>Pages <input id="extract-pages" type="number" min="1" max="100" value="3"></label>`
    : "";
  return `<section id="extract-picker" data-mode="${escapeHtml(proposal.mode)}" data-count="${proposal.count}">
    <h3>${proposal.mode === "list" ? `List · ${proposal.count} on this page` : "One element"}</h3>
    <table><thead><tr><th>Keep</th><th>Column</th><th>Sample</th></tr></thead><tbody>${rows}</tbody></table>
    ${pages}
    <p class="row"><button type="button" id="extract-commit">Save extract</button></p>
  </section>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
}

export function outputCsv(outputs: OutputValue[] | undefined, name?: string): string | undefined {
  const tables = (outputs ?? []).filter((item): item is OutputTable => item.type === "table");
  const table = name ? tables.find((item) => item.name === name) : tables[0];
  if (!table) return undefined;
  return tableToCsv(table.columns.map((column) => column.name), table.rows);
}
