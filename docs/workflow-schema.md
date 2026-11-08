# Workflow schema v4

The contract is `schema/workflow.schema.json`, id `bao.workflow/v4`. `desktop/src/v1/schema.ts` `validateWorkflow` checks the same document the replayer reads. A file with another schema id is not loaded. There is no migrate.

## Document

`schema`, `version` (2), `id`, `name`, `startUrl`, `inputs`, `steps`, `createdAt`. Optional `heal`: `auto` or `approve`. Absent means the global setting, whose default is `auto`. Optional `imported: true` means this copy was installed from someone else. Absent means the owner recorded it. An input's `ownerSaved: true` means the owner saved that value after import. Author defaults omit it.

The schema still accepts `driver: "cdp-live"` so historical workflows remain readable. That driver is retired. App and MCP replay, step Try, and promotion checks refuse it before opening Chrome with `this workflow used the retired live driver`. Replacing an existing retired workflow through edits, imports, conflict resolution, or version promotion preserves its `cdp-live` tag; removing or changing the tag cannot enable replay. `desktop/test/unit/retired-live-driver.test.ts` covers these boundaries. The `agent_browser` pass-through records runs and saves supported single-page tasks as `playwright` workflows for current-engine replay. See [the recording boundary](agent-browser-engine.md).

Library fixture writers set workflow-level `provenance: "fixture"`. These records stay readable in Library, but agent workflow search excludes them. Explicit replay and review still accept fixtures. Search also excludes workflows the caller cannot replay for their driver or selected engine. Search and replay share that refusal check; relay search uses the current extension connection state. The registry filters candidates before its five-hit limit. Search does not infer fixture status from a workflow's name or require a past green replay.

## Inputs

Collected before replay starts. The CLI and MCP pass the same JSON object the form edits.

| type | meaning |
| --- | --- |
| `text` | Any string. The form uses a multiline field. |
| `secret` | Password input with a saved default or a runtime override. Old stripped-value markers still mean missing data. See [saved-file secret handling](permissions.md#secret-text-in-saved-files). |
| `number` | A number. Calculator digits use this. |
| `choice` | One of `choices`. |
| `file` | One file, or many when `multiple` is set. The workflow stores the input name, not a path. |

A step refers to an input with `input` and a template `value` such as `"{{username}}"`. `subst` replaces those tokens at replay.

Historical `cdp-live` recordings keep their saved input names and template tokens. Reading them does not rename fields or migrate them to the pass-through. `desktop/test/unit/live-library.test.ts` covers historical workflow and run display.

## Steps

`action` is `click`, `type`, `key`, `upload`, `drop`, `digits`, `check`, `confirm`, `login`, or `verify`. `surface` is `dom` or `os`. A `confirm` or `login` step waits for the person. Replay does not click or type it. A `verify` step has no target. It re-reads an `expect` after the earlier steps.

`identity` is the recorded element. See `docs/element-identity.md`. There is no coordinate field on it. `provenance` may hold the pixel the vendor asked for, with `space` of `viewport`, `image`, or `screen`. Replay does not read it.

`selection` is optional: `{ "by": "name" | "title" | "text" | "value", "input": "row" }`. Candidates are filtered to that attribute before scoring, so a row click can mean "the row whose name is `{{row}}`" rather than the instance that was on screen.

`postcondition` is `url`, `text`, `value`, `element`, or `absent`, with `timeoutMs`. A `value` match of `{{a}}+{{b}}` is evaluated as arithmetic of number inputs and compared to the live text. Any other match is text, after `{{input}}` substitution. `timeoutMs` on the step is how long lookup polls. The postcondition has its own timeout.

`expect` is read after the action, and again by a trailing `verify` step. `kind` includes `text`, `url`, and `state` (`checked`, `unchecked`, `enabled`, `disabled`, `visible`). A miss stops in a named phase: `wait_for`, `find`, `action`, `expect`, or `auth`. `waitFor` is a check that must become true before find. `gone` is a check that must be absent after the action, and a miss is still phase `expect`. `intent` is the recorded phrase cheap repairs match. `anchor` is `{ identity, relation }` with `relation` of `below`, `above`, `right`, or `left`.

A workflow can declare `precondition` `{ "kind": "url", "match", "phase": "auth" }`. Replay compares the pathname, so a `next` query is not the page. A redirect to `/login` is phase `auth` and is not sent to a model. Password lookup follows the [saved-file replay rules](permissions.md#secret-text-in-saved-files). Without a supplied or saved password, replay shows "Sign in on the site window" and waits. A `confirm` step yields to the person and leaves the banner up. A held remote run continues on its own when its recorded postcondition changes from false to true. The live run banner also has Continue for steps Bao cannot detect, including steps without a postcondition. Neither path presses the site's button. Local Continue signals that the person has acted, even when the recorded postcondition cannot be read or no longer matches. On explicit MCP resume, replay still checks its postcondition; if it is false, the run stays paused. Without a postcondition, MCP resume also signals that the person has acted. That signal applies only to the resumed step, not to later human steps. Replay never executes a confirm step by pressing its target. Repairs and heals cannot click a target reserved for a later confirm unless it also matches their own original recorded control; a positional CSS or XPath match alone is not enough. Ordinary recorded clicks, including Apply, have no separate label-based gate.

`reveal` is a locator for a control that unhides the target. Replay clicks it only when the recorded target is a 0×0 or hidden box, and logs a `reveal` repair. If `reveal` is absent, replay can discover one visible search toggle in a search landmark. `readBack` on a step or on the workflow re-reads `text`, `url`, `value`, or a throwaway `file` after the action. The run appends a hashed receipt (expected, actual, pass, previous hash) and does not rewrite earlier lines. A file read-back names an input; the path is supplied at runtime and must sit under the temp directory. The same shape is what a later "verify freeze status after Apply" step uses: source `text`, match `Status: Frozen`. The local credit-freeze fixture is not a credit bureau.

`locators` is an ordered list tried after a known overlay is closed and before label, anchor, and wait repairs. Each item is `role` (role plus accessible name), `text`, `testid`, `css`, `xpath`, or `anchor`. A locator is used only when exactly one node matches and that node still has a box. A `role` or `text` locator matches a node's text as shown, or with its prices dropped, so a name with no price still finds a control after its price changes. That holds while the control's text fits the 80-character cut the page dump applies to a node's text and name. On a long name, a price with more or fewer digits moves that cut, and replay falls back to the later locators, such as the `href` and position `css` locators. A match as shown comes first, so `Donate` still picks `Donate` beside `Donate $10`. The hit is logged. `primary` replay tries the first locator only. `identity.xpath` is stored for that locator and is not a score. An unnamed text view may use a role locator whose name is empty, which means the only unnamed control of that role. One-way export to Chrome DevTools Recorder JSON is `toPuppeteerReplay`. Anchor locators are omitted. Click steps set `offsetX` and `offsetY` to 1 because `@puppeteer/replay` 4.0.2 forwards a missing offset as `undefined`, and Puppeteer 25 then waits until timeout.

`unresolved` steps are stored so the miss is visible. Replay stops on them instead of skipping. A stripped-value stop can clear with fresh runtime inputs under the [saved-file replay rules](permissions.md#secret-text-in-saved-files).

`when` is optional and has one of three shapes. With `{ "input": "route", "value": "Save the note" }`, the input is a `choice`, and replay runs the step only when that choice equals `value`. Teach uses this when two demonstrations of the same task diverge. With `{ "present": "text" }`, replay runs the step only while the page shows that text, or a control with that name. With `{ "absent": "text" }`, replay runs the step only while the page does not. Historical live recordings may have this on a cart add. `"anyCount": true` goes only beside `absent`. It lets each number in the text match any number, so `{ "absent": "1 in cart", "anyCount": true }` also skips the step while the page shows `3 in cart`. Ordinary `replay()` honors it. Retired `cdp-live` workflows cannot replay. Steps in a row with the same `present` or `absent` are decided once, on the first of them.

`optional: "dismiss"` lets replay skip a recorded DOM dismiss-button click when its target is absent. The [JSON Schema](../schema/workflow-v2.schema.json) defines which controls qualify. Replay waits up to two seconds for the recorded control, using its identity and page context rather than its dismiss label alone. Replay clicks one match and fails multiple matches as a tie. With no match, it stamps the step `skipped` with reason `optional dismiss absent` and skips its post-action checks. For a present target, `expect.kind: "settled"` counts as held when the step has no `postcondition`; other expectations and explicit postconditions still apply. Historical live-driver recordings may contain this field; that recorder no longer runs. Other steps remain required unless their `when` rule skips them.

## Example

This is the login step from `examples/workflows/browser-form.json`, captured from the local fixture page (username, secret, file input, drop). The password string is not in the file.

```json
{
  "action": "type",
  "input": "password",
  "value": "{{password}}",
  "label": "Type secret",
  "surface": "dom",
  "sensitive": true,
  "identity": {
    "surface": "dom",
    "role": "input",
    "id": "password",
    "nameAttr": "password",
    "tag": "input",
    "path": []
  },
  "postcondition": { "kind": "element", "timeoutMs": 4000 },
  "timeoutMs": 8000
}
```

`examples/workflows/calculator.json` is the GTK calculator capture. Digit presses collapsed into `digits` steps with number inputs `a` and `b`. The equals step's postcondition is `{{a}}+{{b}}`.

`examples/workflows/live-login.json` and `examples/workflows/live-upload.json` are interpret output from MCP trails whose `source.agent` is `live-model`. The login secret has no default. The upload step's value is `{{file}}`, not a path. Provenance coordinates are recorded and replay does not read them.

`examples/workflows/browser-form.json` expects the URL `/secure` after Log in, then a `verify` step reads that URL again. `examples/workflows/credit-freeze.json` is the local fixture at `/freeze`. A missing or expired session cookie redirects to `/login` (username, then a `type=password` field, and a "Verify it's you" code step only when `verify=1`). Replay signs in or waits, clicks Frozen, re-reads `Status: none`, and stops at the confirm step. Bao does not press Apply. The page is fake. It is not a credit bureau.

## Interpret

`desktop/src/v1/interpret.ts` is deterministic. The same trail produces byte-identical JSON (`canonical`). It drops screenshot reads, moves, waits, and unresolved no-ops, merges consecutive typing into one field, and lifts typed values into inputs unless marked literal. Target matching in interpretation, condensation, and model-revision validation requires the same `beforeUrl` as well as the same control, so identical element paths or ids on different pages stay separate. A type event with `valueMode: "full"` replaces the earlier merged value, including an empty string, instead of appending a typed chunk. `desktop/test/unit/recording-page-boundary.test.ts` covers page boundaries; `desktop/test/unit/live-oauth-regressions.test.ts` covers full-field corrections. A password field, a sensitive flag, a password/OTP/card autocomplete marker, or a value explicitly listed in `meta.secrets` makes a typed event a `secret` input. Value shape alone does not. Default retention follows the [saved-file replay rules](permissions.md#secret-text-in-saved-files). A file event becomes a `file` input. A path on the trail is not copied. Consecutive digit presses on a calculator become one number input.

An optional model pass may later name the workflow and suggest selection rules. It is not required, and it is not implemented as a network call in the default path. The deterministic pass is the one the tests replay.
