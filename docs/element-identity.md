# Element identity

Replay finds an element by attributes, then refuses if the match is not clearly the same one. A coordinate is provenance from capture. It is not an input to this scorer.

The implementation is `desktop/src/v1/identity.ts`. `ACCEPT` is 60. `MARGIN` is 25. A candidate is used only when its score is at least 60 and it leads the next candidate by at least 25. Otherwise the lookup returns `tie`, `below-threshold`, `no-candidates`, or `app-mismatch`, plus the attribute that broke.

## Shared rules

- The app is a gate, not a score. If the recorded `bundleId` or `app` is set, candidates from another app score nothing and the reason is `app-mismatch`. The broken attribute is `bundleId` or `app`.
- Window title is a weak bonus on the accessibility surfaces. A theme or a document rename does not by itself reject a control that still has a strong id.
- Empty strings do not match. Two unnamed drawing areas do not become a guess.
- Sibling index and the parent path break ties only when they add enough points to clear the margin. Two buttons with the same name and no identifier stay a tie even when their parent paths differ (path is 20 points, and 20 is under the margin of 25).
- The scorer has no x or y field.

`brokenAttr` is the highest-priority recorded attribute the best candidate missed. On a tie it is the attribute the top two do not share, or `ambiguous` when they matched the same set.

## DOM

Priority, then points:

| Attribute | Points | Notes |
| --- | --- | --- |
| `testId` (`data-testid`) | 100 | Exact. Two matches are a tie. |
| `id` | 80, or 15 if unstable | Unstable means a generated id: `ember` / `react` / `mui` / `css-` prefix, a long hex run, `:r1:`, or four digits in a row. 15 cannot pass alone. |
| role + accessible name | 70 | Role is normalized (`button`, `push button`, `AXButton` are the same). The name is matched against accessible name or text. |
| label association | 55 | `<label for>` or wrapping label, or `aria-label`. |
| `name` attribute | 50 | The HTML `name`, not the accessible name. |
| text | 40 | Short visible text. |
| parent path | 20 | Role and name of ancestors. |
| CSS path | 12 | Tie-break only. Never enough alone. |
| sibling index | 8 | Tie-break only. |

A stable id such as `username` passes. A CSS path alone does not.

## macOS Accessibility

Priority, then points. Roles are compared after stripping a leading `AX` and spaces, so `AXButton` and `button` match.

| Attribute | Points | Notes |
| --- | --- | --- |
| `AXIdentifier` | 100 | Wins even when the title changed, if it is unique. |
| role | 20 | Not enough alone. |
| subrole | 15 | |
| name | 50 | Compared to the candidate's name or title. |
| title | 40 | Only when it is different from the name. |
| description | 25 | |
| value | 55 | Only for static text (`AXStaticText` / `label`). The value is the identity of a label, not of a typed secret. |
| parent path | 20 | |
| window title | 10 | |
| sibling index | 8 | |

Role plus name is 70, which clears 60. The next button, sharing the role but not the name, sits at 20. The margin is 50, so a uniquely named button is accepted. Two buttons named the same thing are a tie. That is the refuse line: replay will not pick the left-hand Save.

`fixtures/ax/macos-26/calculator.observed.json` is the keypad the 2026-10-20 spike actually hit-tested (`7`, `Add`, `5`, `Equals`). It is not a full tree. Full dumps belong in that directory as `*.dump.json`, captured on macOS 26 with `bao-os-macos nodes --bundle …`. The command is in `fixtures/ax/macos-26/README.md`. `desktop/test/unit/ax-fixtures.test.ts` scores those dumps when they are present.

## Linux AT-SPI

The same accessibility table, fed by `desktop/src/v1/identity.ts` `fromAtspiNode`. There is usually no identifier, so role plus name is the strong pair. `fixtures/atspi/baocalc.json` is a raw `bao-os-helper nodes` dump of `baocalc.py` on this machine: the `7` button is unique, and the drawing area (empty name, no action) stays under the threshold.

## What replay does with a miss

It stops on that step. The failure carries the reason, `brokenAttr`, and a snapshot (screenshot ref when the browser driver took one, plus the DOM or accessibility nodes that were scored). Healing runs only when a provider is available. See `docs/v1.md`.
