// JSON schema generated from the desktop contract. The web registry imports the emitted file.

const WORKFLOW_SCHEMA_ID = "bao.workflow/v4";

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
    citation: { type: "object", additionalProperties: false, required: ["text", "source"], properties: { text: { type: "string" }, source: { enum: ["text", "name", "label", "aria-label", "placeholder", "alt", "title"] } } },
    targetBox: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height", "viewport"], properties: {
      x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
      viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: { width: { type: "number" }, height: { type: "number" } } },
    } },
  },
};

const target = {
  type: "object",
  additionalProperties: false,
  required: ["locators"],
  properties: {
    locators: { type: "array", items: locator },
    hint: { type: "object" },
    reveal: locator,
    history: { type: "array" },
  },
};

const check = { type: "object", required: ["kind", "timeoutMs"], properties: { kind: { type: "string" }, match: { type: "string" }, timeoutMs: { type: "number" }, locators: { type: "array" }, state: { type: "string" } } };

function step(action: string, required: string[], properties: Record<string, unknown>) {
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
      when: { type: "object" },
      heal: { enum: ["auto", "ask", "never"] },
      readBack: { type: "object" },
      check,
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
      inputs: { type: "array", items: { type: "object", required: ["name", "type", "label", "supply"], properties: { name: { type: "string" }, type: { type: "string" }, label: { type: "string" }, supply: { enum: ["saved", "must"] }, default: { type: "string" } } } },
      steps: { type: "array", items: { oneOf: [
        step("click", ["target"], { target }),
        step("type", ["target", "text"], { target, text: { type: "object" }, sensitive: { type: "boolean" } }),
        step("key", ["key"], { key: { type: "string" }, target }),
        step("check", ["target", "checked"], { target, checked: { type: "boolean" } }),
        step("select", ["target", "text"], { target, text: { type: "object" } }),
        step("navigate", ["url"], { url: { type: "string" } }),
        step("verify", ["check"], {}),
        step("handoff", ["reason"], { reason: { enum: ["sign-in", "code", "owner-press"] }, target }),
        step("upload", ["target", "file"], { target, file: { type: "object" } }),
        step("drop", ["target", "file"], { target, file: { type: "object" } }),
        step("extract", ["extract"], { extract: { type: "object" } }),
        step("for_each", ["forEach"], { forEach: { type: "object" } }),
        step("note", ["text"], { text: { type: "string" } }),
        step("download", ["download"], { download: { type: "object" }, target }),
        step("open", ["open"], { open: { type: "object" } }),
        step("digits", ["text"], { text: { type: "object" }, target }),
        step("pickDate", ["date"], { date: { type: "object" }, target }),
        step("wait", ["reason"], { reason: { type: "string" }, ms: { type: "number" } }),
        step("finish", [], { reason: { type: "string" } }),
      ] } },
      outputs: { type: "array" },
      readBack: { type: "object" },
      precondition: { type: "object" },
      inference: { type: "object" },
    },
  };
}
