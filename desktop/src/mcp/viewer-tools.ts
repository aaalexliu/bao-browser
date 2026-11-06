import type { Library } from "../v1/store";
import { inspectRunView, listRunViews, openStepPictures } from "./run-view";
import { VIEWER_URI } from "./viewer";

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const page = { type: "integer", minimum: 0, maximum: 1_000_000 };
const id = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$", maxLength: 128 };
const appOnly = { ui: { resourceUri: VIEWER_URI, visibility: ["app"] } };

export const VIEWER_TOOLS = [
  {
    name: "list_runs", description: "Show read-only Bao run history on this Mac, five recently updated records per page. Includes a text fallback. Does not run or approve anything.",
    inputSchema: { type: "object", properties: { offset: page }, additionalProperties: false },
    annotations, _meta: { ui: { resourceUri: VIEWER_URI, visibility: ["model", "app"] } },
  },
  {
    name: "inspect_run", description: "Read a bounded run receipt and its workflow steps. No pictures, raw snapshots, inputs, or resume tokens.",
    inputSchema: { type: "object", properties: { run_id: id, step_offset: page, workflow_offset: page }, required: ["run_id"], additionalProperties: false },
    annotations, _meta: appOnly,
  },
  {
    name: "open_step_pictures", description: "Read pictures only after the owner clicks Open step pictures. Sends at most two redacted-policy pictures, each at most 512 KiB, to the host app, in UI-only metadata. Sensitive or unclassified steps are withheld.",
    inputSchema: { type: "object", properties: { run_id: id, step_id: id }, required: ["run_id", "step_id"], additionalProperties: false },
    annotations, _meta: appOnly,
  },
];

export function isViewerTool(name: string): boolean {
  return VIEWER_TOOLS.some((tool) => tool.name === name);
}

export function callViewerTool(library: Library, name: string, args: Record<string, unknown>) {
  if (name === "open_step_pictures") {
    const data = openStepPictures(library, args);
    return {
      content: [{ type: "text", text: `${data.pictures.length} shareable step pictures opened for ${data.runId}/${data.stepId}. Pictures go to the host app, not the model-visible result. Missing, linked, private, invalid, or oversized pictures are withheld.` }],
      _meta: { baoPictures: data }, isError: false,
    };
  }
  const data = name === "list_runs" ? listRunViews(library, args) : inspectRunView(library, args);
  return { content: [{ type: "text", text: JSON.stringify(data) }], _meta: { baoViewer: data }, isError: false };
}
