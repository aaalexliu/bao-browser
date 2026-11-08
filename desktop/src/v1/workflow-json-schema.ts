// JSON schema generated from the desktop contract. The web registry imports the emitted file.

import { WORKFLOW_SCHEMA_ID } from "./schema";

const locator = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "role", "name"], properties: { kind: { const: "role" }, role: { type: "string" }, name: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { enum: ["text", "testid", "css", "xpath"] }, value: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["kind", "relation", "anchor"], properties: {
      kind: { const: "anchor" },
      relation: { enum: ["below", "above", "right", "left"] },
      role: { type: "string" },
      anchor: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string" }, name: { type: "string" }, text: { type: "string" }, testId: { type: "string" }, id: { type: "string" } } },
    } },
  ],
};

const caption = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1 },
    citation: { type: "object", additionalProperties: false, required: ["text", "source"], properties: { text: { type: "string", minLength: 1 }, source: { enum: ["text", "name", "label", "aria-label", "placeholder", "alt", "title"] } } },
    targetBox: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height", "viewport"], properties: {
      x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
      viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } } },
    } },
  },
};

const target = {
  type: "object",
  additionalProperties: false,
  required: ["locators"],
  properties: {
    locators: { type: "array", items: locator },
    hint: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string" },
        nameAttr: { type: "string" },
        role: { type: "string" },
        surface: { enum: ["dom", "ax", "atspi"] },
        path: { type: "array", items: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string" }, name: { type: "string" } } } },
        tag: { type: "string" },
        inputType: { type: "string" },
        autocomplete: { type: "string" },
        placeholder: { type: "string" },
      },
    },
    reveal: locator,
    history: { type: "array" },
  },
};

const name = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$" };
const textOf = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["input"], properties: { input: name } },
    { type: "object", additionalProperties: false, required: ["literal"], properties: { literal: { type: "string" } } },
  ],
};
const fileOf = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["input"], properties: { input: name } },
    { type: "object", additionalProperties: false, required: ["fromOutput"], properties: { fromOutput: name } },
  ],
};
const hint = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    nameAttr: { type: "string" },
    role: { type: "string" },
    surface: { enum: ["dom", "ax", "atspi"] },
    path: { type: "array", items: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string" }, name: { type: "string" } } } },
    tag: { type: "string" },
    inputType: { type: "string" },
    autocomplete: { type: "string" },
    placeholder: { type: "string" },
  },
};
const check = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "timeoutMs"], properties: { kind: { const: "settled" }, timeoutMs: { type: "number" } } },
    { type: "object", additionalProperties: false, required: ["kind", "match", "timeoutMs"], properties: { kind: { enum: ["text", "url", "value"] }, match: { type: "string", minLength: 1 }, timeoutMs: { type: "number" } } },
    { type: "object", additionalProperties: false, required: ["kind", "locators", "timeoutMs"], properties: { kind: { enum: ["element", "absent"] }, locators: { type: "array", minItems: 1, items: locator }, hint, timeoutMs: { type: "number" } } },
    { type: "object", additionalProperties: false, required: ["kind", "state", "locators", "timeoutMs"], properties: { kind: { const: "state" }, state: { enum: ["checked", "unchecked", "enabled", "disabled", "visible"] }, locators: { type: "array", minItems: 1, items: locator }, timeoutMs: { type: "number" } } },
  ],
};
const when = {
  type: "object",
  additionalProperties: false,
  properties: {
    input: name,
    value: { type: "string", minLength: 1 },
    present: { type: "string", minLength: 1 },
    absent: { type: "string", minLength: 1 },
    anyCount: { type: "boolean" },
  },
  anyOf: [{ required: ["present"] }, { required: ["absent"] }, { required: ["input", "value"] }],
};
const readBack = {
  type: "object",
  additionalProperties: false,
  required: ["source", "match", "timeoutMs"],
  properties: {
    source: { enum: ["value", "text", "url", "file"] },
    match: { type: "string", minLength: 1 },
    locators: { type: "array", items: locator },
    hint,
    fileInput: name,
    timeoutMs: { type: "number" },
  },
};
const openOf = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["target", "url"], properties: { target: { const: "url" }, url: { type: "string", minLength: 1 } } },
    { type: "object", additionalProperties: false, required: ["target", "file"], properties: { target: { const: "file" }, file: { type: "string", minLength: 1 }, app: { type: "string" } } },
  ],
};
const downloadOf = {
  type: "object",
  additionalProperties: false,
  required: ["output", "name"],
  properties: { output: name, name: { type: "string", minLength: 1 }, url: { type: "string" } },
};
const dateOf = {
  type: "object",
  additionalProperties: false,
  required: ["input"],
  properties: { input: name, endInput: name },
};
const column = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "read"],
  properties: {
    name,
    label: { type: "string" },
    type: { enum: ["text", "number", "url"] },
    read: { enum: ["text", "href", "src", "value", "title", "rating"] },
    locators: { type: "array", items: locator },
    dropped: { type: "boolean" },
  },
};
const extractOf = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "locators", "columns", "as"],
  properties: {
    mode: { enum: ["element", "list"] },
    locators: { type: "array", minItems: 1, items: locator },
    columns: { type: "array", minItems: 1, items: column },
    as: name,
    pagination: { type: "object", additionalProperties: false, required: ["next", "maxPages"], properties: { next: { type: "array", minItems: 1, items: locator }, maxPages: { type: "integer", minimum: 1, maximum: 100 } } },
  },
};

function step(action: string, required: string[], properties: Record<string, unknown>, withCheck = true) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "index", "action", "caption", "timeoutMs", ...required],
    properties: {
      id: { type: "string" },
      index: { type: "number" },
      action: { const: action },
      caption,
      timeoutMs: { type: "number" },
      when,
      heal: { enum: ["auto", "ask", "never"] },
      readBack,
      ...(withCheck ? { check } : {}),
      ...properties,
    },
  };
}

export function workflowJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: WORKFLOW_SCHEMA_ID,
    title: "Bao workflow",
    type: "object",
    additionalProperties: false,
    required: ["schema", "id", "name", "startUrl", "inputs", "steps", "createdAt"],
    properties: {
      schema: { const: WORKFLOW_SCHEMA_ID },
      id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      startUrl: { type: "string" },
      createdAt: { type: "number" },
      updatedAt: { type: "number" },
      provenance: { const: "fixture" },
      heal: { enum: ["auto", "approve"] },
      replayed: { type: "boolean" },
      summary: { type: "string" },
      intent: { type: "string" },
      driver: { enum: ["playwright", "extension"] },
      imported: { const: true },
      inputs: { type: "array", items: {
        type: "object",
        required: ["name", "type", "label", "supply"],
        properties: {
          name,
          type: { enum: ["text", "secret", "number", "choice", "file", "date", "table"] },
          label: { type: "string", minLength: 1 },
          supply: { enum: ["saved", "must"] },
          default: { type: "string", minLength: 1 },
          ownerSaved: { const: true },
          askOnImport: { type: "boolean" },
          example: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          multiple: { type: "boolean" },
          accept: { type: "string" },
          format: { type: "string" },
          relative: { type: "string" },
          zone: { type: "string" },
          fromOutput: name,
        },
        allOf: [
          { if: { properties: { supply: { const: "saved" } }, required: ["supply"] }, then: { required: ["default"], not: { properties: { type: { const: "file" } }, required: ["type"] } } },
          { if: { properties: { supply: { const: "must" } }, required: ["supply"] }, then: { not: { required: ["default"] } } },
          { if: { properties: { type: { const: "choice" } }, required: ["type"] }, then: { required: ["choices"], properties: { choices: { minItems: 1 } } } },
        ],
      } },
      steps: { type: "array", items: { oneOf: [
        step("click", ["target"], {
          target,
          optional: { const: "dismiss" },
          selection: { type: "object", additionalProperties: false, required: ["by", "input"], properties: { by: { enum: ["name", "title", "text", "value"] }, input: { type: "string" } } },
          dialog: { type: "object", additionalProperties: false, required: ["input"], properties: { input: { type: "string" } } },
        }),
        step("type", ["target", "text"], { target, text: textOf, sensitive: { type: "boolean" } }),
        step("key", ["key"], { key: { type: "string", minLength: 1 }, target }),
        step("check", ["target", "checked"], { target, checked: { type: "boolean" } }),
        step("select", ["target", "text"], { target, text: textOf }),
        step("navigate", ["url"], { url: { type: "string" } }),
        step("verify", ["check"], {}),
        step("handoff", ["reason"], { reason: { enum: ["sign-in", "code", "owner-press"] }, target }),
        step("upload", ["target", "file"], { target, file: fileOf }),
        step("drop", ["target", "file"], { target, file: fileOf }),
        step("extract", ["extract"], { extract: extractOf }, false),
        step("for_each", ["forEach"], { forEach: { type: "object", additionalProperties: false, required: ["over", "steps"], properties: { over: { oneOf: [{ type: "object", additionalProperties: false, required: ["kind", "name"], properties: { kind: { const: "input" }, name } }, { type: "object", additionalProperties: false, required: ["kind", "name"], properties: { kind: { const: "extract" }, name } }] }, steps: { type: "array", minItems: 1 } } } }, false),
        step("note", ["text"], { text: { type: "string", minLength: 1 } }, false),
        step("download", ["download"], { download: downloadOf, target }),
        step("open", ["open"], { open: openOf }),
        step("digits", ["text"], { text: textOf, target }),
        step("pickDate", ["date"], { date: dateOf, target }),
        step("wait", ["reason"], { reason: { type: "string" }, ms: { type: "number" } }, false),
        step("finish", [], { reason: { type: "string" } }, false),
      ] } },
      outputs: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type", "from"], properties: { name, type: { enum: ["table", "text", "number"] }, from: { type: "string", minLength: 1 }, label: { type: "string" }, columns: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name, type: { enum: ["text", "number", "url"] } } } } } } },
      readBack,
      precondition: { type: "object", additionalProperties: false, required: ["kind", "match", "phase"], properties: { kind: { const: "url" }, match: { type: "string", minLength: 1 }, phase: { const: "auth" } } },
      inference: { type: "object" },
    },
  };
}
