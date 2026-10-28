// Workflow tools the relay is willing to forward. ToolName is this array.

import { randomBytes } from "node:crypto";

export const SERVER_VERSION = "0.3.0";

export const RELAY_CODE_TTL_MS = 120_000;

/** Result files are named with this id, so the path cannot leave relay-results. */
export const JOB_ID = /^job-[0-9a-f-]+$/;

export const RELAY_TOOLS = [
  {
    name: "search_workflows",
    description: "Search workflows saved on the paired device. At most 5 hits, each with its input schema.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, deviceId: { type: "string" } } },
  },
  {
    name: "describe_workflow",
    description: "Steps, input schema, and bao:// link for one workflow on the paired device. Secret defaults are omitted.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, deviceId: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: "Ask the paired device to replay a saved workflow. The device must approve before anything runs. A confirm step cannot be approved from here.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        inputs: { type: "object" },
        deviceId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "resume_workflow",
    description: "Continue a paused run. A confirm, payment, send, login, or bot wall can only be approved on the device. This call cannot approve those.",
    inputSchema: {
      type: "object",
      properties: { resume: { type: "string" }, deviceId: { type: "string" } },
      required: ["resume"],
    },
  },
  {
    name: "get_run",
    description: "Read the stored outputs of a run on the paired device. Screenshot bytes and secrets are omitted.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, deviceId: { type: "string" } },
      required: ["run_id"],
    },
  },
] as const;

export type ToolName = (typeof RELAY_TOOLS)[number]["name"];

export function isToolName(value: string): value is ToolName {
  return RELAY_TOOLS.some((tool) => tool.name === value);
}

export function pairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("");
}
