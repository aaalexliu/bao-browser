# Bao Browser - M4 Design (parameterization, extract, forEach loops, export)

> Parent docs: [[product-design-v1]] (architecture, IR, the `extract` action sketch),
> [[m1-design]] (the SW-owned RunState machine this extends), [[recording-gaps-and-app-universe]]
> (where "act on every item matching X" is parked as an IR feature, not a capture gap),
> [[backend-webapp-design]] (parameterization as the prerequisite for sharing).
> Status: M0-M2 replay is deterministic, flat, and green. This adds the four IR features
> that turn a linear macro into a small structured workflow: **variables**, **extract**,
> **forEach loops**, and **export**. No LLM enters the runtime.

## Goal

Author, from a single recording, workflows that:

1. **Parameterize** a value the runner supplies at replay (`{{search_term}}`).
2. **Extract** a value off the page (a name, an href, a data-id) into a variable.
3. **Loop** over every item matching a repeating pattern - to *scrape* (collect rows and
   export) **and** to *act* ("remove all my subscriptions", "add every Chase offer").
4. **Export** the collected rows as CSV or JSON.

Two acceptance flows, deliberately at opposite ends of the loop design space:

- **Scrape:** contacts page -> for each `.contact-row`, extract name + email -> export `contacts.csv`.
- **Mutate:** subscriptions page -> for each remaining subscription, click *Cancel* -> until none remain.

## The one constraint (why this does not erode the thesis)

Bao's value is **the LLM is not the runtime**; replay re-finds a *recorded* target with
deterministic code. A naive loop ("act on the newest item matching X") breaks that, because
it selects *new* targets at runtime.

The way through: a loop iterates over a **collection pattern compiled once at authoring
time**. At replay, "find the elements matching this repeating pattern" is the same
deterministic DOM query the resolver already does - it just returns N (or "the next one")
instead of asserting `unique === 1`. The *selection logic* is fixed at authoring; only the
*iteration count* is data-driven. No LLM in the runtime loop. Iteration is data over a fixed
program, exactly like the rest of the engine.

---

## 1. Variables (parameterization)

`Workflow.variables` changes from `string[]` to typed declarations. Old workflows carry
`[]`, so this is backward compatible.

```jsonc
Workflow.variables: [
  { name: "search_term", kind: "input",     type: "text",   prompt: "Search for?", default?: "" },
  { name: "contact_name", kind: "extracted", type: "text" },              // written by an extract step
  { name: "row",          kind: "loop",      type: "element" }            // bound by a forEach
]
```

Three **kinds**, distinguished by lifecycle - this is the whole model:

| kind | bound when | by | example |
|---|---|---|---|
| `input` | run start | prompted from the runner | the term to search, the account to use |
| `extracted` | mid-run | an `extract` step | a copied name / id / total |
| `loop` | per iteration | a `forEach` | the current row's element scope |

**Substitution.** A pass resolves `{{name}}` in `value`, `url`, and `urlPattern`
immediately before a step dispatches. That is the entire runtime cost of parameterization.
`RunState` gains one field: `bindings: Record<string, Value>`. The existing T1 masked-input
slot ("field is focused but not filled; the user supplies the secret") is the first
`kind: "input"` variable in disguise - parameterization generalizes it.

---

## 2. `extract` (the "copy a name / element")

New `StepAction: "extract"`. Structurally it is a sibling of `assert`: both resolve a
`Target` and then *read* the page instead of acting on it. It reuses 100% of the
target-resolution stack, so the risky part (finding the element) is already built and tested.

```jsonc
{
  action: "extract",
  label: "Copy the contact's name",
  target: { ...standard Target... },
  extract: {
    source: "text" | "attr" | "href" | "value" | "input",
    attr?: "data-id",       // when source === "attr"
    trim?: true,
    into: "contact_name"    // binding name (scalar) OR row field name (inside a loop)
  }
}
```

- **Outside a loop:** writes a scalar into `bindings[into]` (a `kind: "extracted"` variable).
- **Inside a loop:** writes a field on the current row (see 3.4). Same step, scoped target.

---

## 3. `forEach` loops

The one feature with real runtime surface. Everything here is a consequence of two choices:
how the loop is represented in the flat IR, and how it iterates a collection that may or may
not change under it.

### 3.1 Representation: flat block markers, not a nested body

The engine's invariants today are all **flat**: `steps[]` advanced by `stepIndex++`, a
results array 1:1 with executed steps, a filmstrip frame per executed step, a dashboard
editor that reorders a flat list. A nested `body: Step[]` would force every one of those to
handle a tree.

Instead, bracket the body with two sentinel steps, bytecode-style:

```jsonc
{ action: "forEach", blockId: "b1", loop: { ...see 3.2... } },
  //  body steps live inline here; their targets resolve *within* the current item (3.3)
  { action: "extract", extract: { source: "text", into: "contact_name" }, target: {...} },
  { action: "extract", extract: { source: "href", into: "contact_email" }, target: {...} },
{ action: "endForEach", blockId: "b1" }
```

`stepIndex` just **jumps** backward at `endForEach`. The state machine, run-history indexing,
and the filmstrip keep working unchanged: a 3-item loop over a 2-step body naturally produces
6 frames, which is the honest audit trail you want for a destructive run. Nesting falls out
for free via a stack. Cost: one `loopStack` on `RunState`.

**Alternatives considered: a self-contained `scrape` step that owns the loop.** The tempting
shortcut is one fat step - `{ action: "scrape", collection, fields: [{source, into}, ...] }` -
that bundles the collection and the per-item reads, no sentinels, no `loopStack`. For the
read-only contacts case it *is* nicer. It fails as the general answer for three reasons.
(1) **The mutate case has no `fields[]`.** "Cancel every subscription" *acts* per item (click,
wait, confirm, submit); a field list can only *read*. So a scrape step can't express draining
loops at all, forcing a *second* loop construct - two iterators, two relative-resolution paths,
two termination models, two audit integrations. Sentinels use **one** loop for both, because a
body is just the normal step vocabulary. (2) **It hides the tree instead of removing it.** A
3-row x 2-field scrape still owes 6 result records, 6 filmstrip frames, and field-level editing -
so the flat invariants (results 1:1 with steps, a frame per step, a reorderable flat list) get
re-implemented *inside* the step, where none of the existing machinery reaches. (3) **`extract`
must exist as a standalone leaf anyway** (the scalar copy-one-name case, §2); giving it loop
semantics too means two shapes for one action. **The resolution is composition, not fusion:**
`extract` stays a single-purpose leaf, `forEach`/`endForEach` is an orthogonal wrapper over
*any* leaves, and the two compose (extract in a loop, out of one, or nested). The ergonomic
declarative `scrape` shape is kept - but as **authoring/compile-time sugar that desugars to the
sentinel form** (§5's generalize-from-one is where the lift happens), so there is exactly one
runtime iterator and the mutate case comes for free.

### 3.2 The loop descriptor - and the two iteration modes

This is the load-bearing decision. "Scrape every contact" and "cancel every subscription"
are **not** the same loop, because the second one *mutates the collection while iterating it*.
Cancel subscription #0 and the list re-renders; a handle you pre-resolved for #2 is now stale.

So `mode` is explicit:

```jsonc
loop: {
  collection: { ...Target resolving to a repeating pattern... },
  itemVar: "row",
  indexVar?: "i",
  mode: "stable" | "draining",
  todo?:  { ... predicate for draining: which items still need doing ... },
  max?: 500,                          // hard safety cap
  onItemError: "skip" | "abort",      // "skip" keeps a scrape going past one bad row
  confirm?: boolean                    // draining default true: pause + count before acting
}
```

**`mode: "stable"` (scrape, read-only body).** The collection is snapshotted to N locators at
loop entry; the DOM does not change under us. Iterate `i = 0..N-1`, bind `itemVar` to
`items[i]`. This is the contacts case.

**`mode: "draining"` (mutate-until-done body).** Never trust a pre-snapshot. Each pass:
**re-resolve the collection fresh**, take the *head* item still matching `todo`, act on it,
wait for the page to settle, repeat. Terminate when no item matches `todo`, or `max` is hit,
or the **no-progress guard** trips (todo-count did not decrease after an iteration -> abort,
so a silently-failing action can never spin forever). Two sub-shapes:

- *Consumed* - "remove all subscriptions": the acted item leaves the set on its own. `todo`
  is just "any `.subscription-row` exists".
- *State-flip* - "add every Chase offer": items persist but flip state. `todo` must
  distinguish todo from done (button label is "Add", not "Added"), or the loop never
  terminates. Record-first-generalize infers this from the recorded target's own signature
  (you clicked a button reading "Add"; done items read "Added").

| | stable (scrape) | draining (mutate) |
|---|---|---|
| collection resolved | once, at entry | every iteration |
| iterate by | index `0..N-1` | head of `todo` set |
| terminates when | index exhausts N | `todo` empty / no progress / `max` |
| body | read-only (`extract`) | acts (click/input/submit) |
| item handle staleness | not possible | avoided by re-resolving |

### 3.3 Relative resolution (the mechanic that makes any of it correct)

Body steps must resolve *within the current item*, or every iteration hits row 1. This maps
directly onto machinery already in `types.ts`: `AnchorDescriptor` + `WithinDescriptor`, built
for ambiguous-target capture. The loop pushes the current item element as the active anchor;
body targets resolve `within` it, not against the whole page. Loops are the anchor system's
second customer - no new resolution primitive needed.

### 3.4 Runtime: `loopStack` + `dataset`

```jsonc
RunState += {
  bindings: Record<string, Value>,
  dataset:  Row[],                    // committed rows, drained to export
  loopStack: LoopFrame[]
}
LoopFrame {
  blockId, mode, itemVar, indexVar?,
  bodyStart, bodyEnd,                 // step indices bracketing the body
  items?: Locator[],                  // stable mode: the snapshot
  i: number,                          // stable: index; draining: iteration count
  row: Row                            // the in-progress row (extract writes here)
}
```

State-machine additions, localized to the advance logic in `background.ts`:

- **on `forEach`:** resolve `collection`. Stable -> snapshot `items`. Draining -> count `todo`;
  if `confirm`, pause (reuse the `waitForUser` primitive) showing "About to *Cancel* on 24
  items - continue / cancel". If the set is empty and that is unexpected, fail cleanly ("the
  page changed - re-record"), never a stack trace. Push the frame, bind `itemVar`, enter body
  (or jump past `endForEach` if empty).
- **body step:** target resolution consults `loopStack.top`'s current item as scope (3.3);
  `extract` writes into `frame.row`.
- **on `endForEach`:** commit `frame.row` to `dataset` (if non-empty). Stable: `i++`, more ->
  rebind + jump to `bodyStart`, else pop. Draining: re-resolve `todo`; a remaining item ->
  rebind head + jump, else pop. Enforce `max` and the no-progress guard on every pass.

### 3.5 Safety for destructive loops (non-negotiable)

"Remove all subscriptions" and "add every offer" are irreversible against a real account, so
draining loops get guardrails scraping does not need:

- **Confirm-with-count** before the first mutation (reuses `waitForUser`; default on).
- **Dry-run:** resolve + highlight every target and step through the body *without* the
  mutating action, to preview scope. A run-mode flag, not new IR.
- **`max` cap** and the **no-progress guard** (3.2) - belt and suspenders against infinite loops.
- **Per-item audit:** the filmstrip already captures a frame per executed step, so a 24-cancel
  run leaves 24 before/after frames for review. `onItemError: "skip"` records which items
  failed without aborting the batch.

---

## 4. Export (CSV / JSON)

`dataset` accumulates across the run (one row per stable-loop iteration; scalar extracts form
a single-row dataset). A terminal action serializes it:

```jsonc
{ action: "export",
  export: { format: "csv" | "json", columns?: ["contact_name","contact_email"], filename?: "contacts.csv" } }
```

`columns` gives deterministic, readable column order; default to the union of row keys.
Serialization is ~30 lines. **The download path is already built (T10):** `chrome.downloads`,
`expectedDownload`, the `download:complete` wait, and the filmstrip capture. Export is a
*synthesized* download (a data/blob URL) instead of a page-triggered one - it reuses that
whole plumbing rather than adding a new egress path.

---

## 5. Authoring: record-first, then generalize

Decided with the user (2026-07-22): the default authoring path is **record on one item, then
generalize**, because it is the non-technical UX and it keeps the LLM at compile time.

1. User records the action on *one* item (copy one name; cancel one subscription).
2. Bao detects the repeating-ancestor pattern around that item and offers: **"Do this for all
   24 matching items?"** It lifts the single item's anchor into a `collection`, rewrites the
   recorded body steps as relative (`within` the item), and infers `mode`: a read-only body ->
   `stable`; a body that clicks a control which removes/flips the item -> `draining`, with
   `todo` derived from the recorded control's signature (3.2).
3. The compile-time LLM pass (M2) names the collection, the extract columns, and the loop
   label ("For each subscription, cancel it") - the readable trust surface, generated once.

Manual **"Wrap in loop"** in the dashboard editor is the escape hatch: select a contiguous run
of steps, pick the collection element, name columns / choose mode. Variables surface as an
"Inputs" panel (kind=input); extracted/loop vars show as read-only chips on their producing
steps.

---

## 6. Schema changes (summary)

```jsonc
// types.ts
StepAction += "extract" | "forEach" | "endForEach" | "export"
Step += { extract?, loop?, export?, blockId? }
Workflow.variables: VariableDecl[]     // was string[]; migrate old [] transparently
RunState += { bindings, dataset, loopStack }
Value  = string | number | boolean | ElementLocator
Row    = Record<string, string>
```

New runtime messages: `bao-run-start` carries `inputs: Record<string,Value>` (the prompted
input variables). No change to the content-script protocol beyond extract's read result.

---

## 7. Build order

Each slice ships independently and is testable with the existing `test/` fixture harness.
The genuinely novel runtime work (loops) lands last, on top of three proven low-risk pieces:

1. **Variables + `{{substitution}}`** - smallest; also formalizes the T1 password slot. Fixture
   with one `input` var.
2. **`extract` (scalar)** - assert-shaped; reuses target resolution. Prove read-into-binding.
3. **`export`** - reuses T10 downloads. Prove single-row CSV + JSON out.
4. **`forEach` / `endForEach`** - `loopStack`, relative resolution, dataset. Do **stable** mode
   first (contacts fixture), then **draining** (a subscriptions fixture that re-renders on
   delete, to prove re-resolve + no-progress guard).
5. **Authoring** - generalize-from-one + editor "Wrap in loop".

---

## 8. Open questions

- **Nested loops:** the `loopStack` supports them mechanically; do we expose them in authoring
  v1, or restrict to one level and revisit?
- **Draining `todo` inference:** how confident can generalize-from-one be at distinguishing
  done vs todo state without an explicit user confirm on the predicate? Leaning: always show
  the inferred predicate in the confirm-with-count dialog so the user validates scope before
  the first mutation.
- **Export target:** download-only (this doc), or also "copy to clipboard" / write into a
  `{{variable}}` for a later step to consume? Download-only for v1; clipboard is a backlog item.
- **Sharing (backend-webapp-design):** typed `variables` are the prerequisite that doc calls
  out. This design produces them; the share-review flow consumes them. Kept orthogonal here.
