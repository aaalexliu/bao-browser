import type { Library } from "../v1/store";
import { inspectMcpRunView, openBrowserPicture, openStepPictures, VIEWER_ID_PATTERN } from "./run-view";
import { VIEWER_URI } from "./viewer";

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const page = { type: "integer", minimum: 0, maximum: 1_000_000 };
const id = { type: "string", pattern: VIEWER_ID_PATTERN, maxLength: 128 };
const appOnly = { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } };

export const LIST_RUNS_TOOL = {
  name: "list_runs", description: "Show read-only Bao run history on this Mac, five recently updated records per page. Includes a text fallback. Does not run or approve anything.",
  inputSchema: { type: "object", properties: { offset: page }, additionalProperties: false },
  annotations,
};

export const VIEWER_TOOLS = [
  {
    name: "inspect_run", description: "Read a bounded run receipt and its workflow steps. No pictures, raw snapshots, inputs, or resume tokens.",
    inputSchema: { type: "object", properties: { run_id: id, step_offset: page, workflow_offset: page }, required: ["run_id"], additionalProperties: false },
    annotations, _meta: appOnly,
  },
  {
    name: "open_browser_picture", description: "Read the current browser card's before or after picture after the app mounts. At most one picture of at most 2 MiB, in app-only metadata.",
    inputSchema: { type: "object", properties: { run_id: id, step_id: id, phase: { type: "string", enum: ["before", "after"] } }, required: ["run_id", "step_id", "phase"], additionalProperties: false },
    annotations, _meta: appOnly,
  },
  {
    name: "open_step_pictures", description: "Read a recorded step's pictures after the owner clicks Open step pictures. Sends at most two PNG/JPEG pictures, each at most 512 KiB for replays or 2 MiB for captures, to the host app in UI-only metadata.",
    inputSchema: { type: "object", properties: { run_id: id, step_id: id }, required: ["run_id", "step_id"], additionalProperties: false },
    annotations, _meta: appOnly,
  },
];

export function isViewerTool(name: string): boolean {
  return VIEWER_TOOLS.some((tool) => tool.name === name);
}

export function callViewerTool(library: Library, name: string, args: Record<string, unknown>) {
  if (name === "open_step_pictures" || name === "open_browser_picture") {
    const data = name === "open_browser_picture" ? openBrowserPicture(library, args) : openStepPictures(library, args);
    return {
      content: [{ type: "text", text: `${data.pictures.length} step pictures opened for ${data.runId}/${data.stepId}. Pictures go to the host app, not the model-visible result. Missing, linked, invalid, or oversized pictures are unavailable.` }],
      _meta: { baoPictures: data }, isError: false,
    };
  }
  const data = inspectMcpRunView(library, args);
  return { content: [{ type: "text", text: JSON.stringify(data) }], _meta: { baoViewer: data }, isError: false };
}
