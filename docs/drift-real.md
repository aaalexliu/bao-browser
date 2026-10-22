# Drift report

Generated 2026-10-21T20:44:46.822Z. Rates exclude n/a rows. Each failure lists the attribute that broke.

| change | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- |
| move | 6 | 0 | 0 | 100% |
| resize | 6 | 0 | 0 | 100% |
| scale | 6 | 0 | 0 | 100% |
| theme-dark | 6 | 0 | 0 | 100% |
| theme-light | 6 | 0 | 0 | 100% |
| font | 6 | 0 | 0 | 100% |
| lang | 5 | 0 | 1 | 100% |
| slow | 6 | 0 | 0 | 100% |
| stale-label | 1 | 0 | 0 | 100% |

## Steps

| step | label | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- | --- |
| wf-wikipedia-0 | Type {{search}} | 8 | 0 | 0 | 100% |
| wf-wikipedia-1 | Press Enter | 8 | 0 | 0 | 100% |
| wf-python-0 | Click "Search" | 8 | 0 | 0 | 100% |
| wf-python-1 | Type {{q}} | 8 | 0 | 0 | 100% |
| wf-python-2 | Press Enter | 8 | 0 | 0 | 100% |
| wf-dynamic-0 | Click "Start" | 7 | 0 | 0 | 100% |
| lang |  | 0 | 0 | 1 | 0% |
| wf-add-0 | Click "Add Element" | 1 | 0 | 0 | 100% |

## Workflows

| workflow | passed | failed | n/a | rate |
| --- | --- | --- | --- | --- |
| wikipedia-search | 16 | 0 | 0 | 100% |
| python-search | 24 | 0 | 0 | 100% |
| internet-dynamic | 7 | 0 | 1 | 100% |
| internet-add | 1 | 0 | 0 | 100% |

## Failures

| workflow | change | step | phase | attribute | fixed by | reason |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | none |

## Recovered

The first locator missed. A later locator, a repair, or a heal made the step pass.

| workflow | change | step | phase | attribute | fixed by | reason |
| --- | --- | --- | --- | --- | --- | --- |
| wikipedia-search | move | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | move | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | resize | wf-wikipedia-0 |  | role | reveal | recorded role Search |
| wikipedia-search | resize | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | resize | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | scale | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | scale | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | theme-dark | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | theme-dark | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | theme-light | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | theme-light | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | font | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | font | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | lang | wf-wikipedia-0 |  | role | locator:css | css Buscar en Wikipedia |
| wikipedia-search | lang | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | lang | wf-python-0 |  | role | locator:css | css Búsqueda |
| python-search | lang | wf-python-1 |  | role | locator:css | css Búsqueda |
| python-search | lang | wf-python-2 |  | expect | wait | expect became true |
| wikipedia-search | slow | wf-wikipedia-1 |  | expect | wait | expect became true |
| python-search | slow | wf-python-2 |  | expect | wait | expect became true |
| internet-add | stale-label | wf-add-0 |  | role | label | Add Element ~ Add Element (1.00) |

## Single locator versus multi locator

Primary replays the first locator only, then the repair tiers. Multi tries role, text, test id, css, xpath, and the anchor before those repairs.

| workflow | change | primary | multi |
| --- | --- | --- | --- |
| wikipedia-search | move | 2/2 | 2/2 |
| python-search | move | 3/3 | 3/3 |
| internet-dynamic | move | 1/1 | 1/1 |
| wikipedia-search | resize | 2/2 | 2/2 |
| python-search | resize | 3/3 | 3/3 |
| internet-dynamic | resize | 1/1 | 1/1 |
| wikipedia-search | scale | 2/2 | 2/2 |
| python-search | scale | 3/3 | 3/3 |
| internet-dynamic | scale | 1/1 | 1/1 |
| wikipedia-search | theme-dark | 2/2 | 2/2 |
| python-search | theme-dark | 3/3 | 3/3 |
| internet-dynamic | theme-dark | 1/1 | 1/1 |
| wikipedia-search | theme-light | 2/2 | 2/2 |
| python-search | theme-light | 3/3 | 3/3 |
| internet-dynamic | theme-light | 1/1 | 1/1 |
| wikipedia-search | font | 2/2 | 2/2 |
| python-search | font | 3/3 | 3/3 |
| internet-dynamic | font | 1/1 | 1/1 |
| wikipedia-search | lang | 0/1 | 2/2 |
| python-search | lang | 0/1 | 3/3 |
| internet-dynamic | lang | n/a | n/a |
| wikipedia-search | slow | 2/2 | 2/2 |
| python-search | slow | 3/3 | 3/3 |
| internet-dynamic | slow | 1/1 | 1/1 |
| internet-add | stale-label | 1/1 | 1/1 |

## Trajectory

Each checked replay is diffed against the recording: target identity, action, postcondition, and timing bucket. A difference here does not change the pass rate.

### wikipedia-search / move

- Step wf-wikipedia-1 finished in the under 1s bucket in the recording and the under 10s bucket on replay.

### python-search / move

- Step wf-python-2 finished in the under 1s bucket in the recording and the under 10s bucket on replay.

### internet-dynamic / move

- Step wf-dynamic-0 finished in the under 10s bucket in the recording and the under 1s bucket on replay.

### wikipedia-search / resize

- Step wf-wikipedia-0 aimed at input#searchInput in the recording and at combobox[name=search] on replay.
- Step wf-wikipedia-1 finished in the under 1s bucket in the recording and the under 10s bucket on replay.

### python-search / resize

- Step wf-python-2 finished in the under 1s bucket in the recording and the under 10s bucket on replay.

### internet-dynamic / resize

- Step wf-dynamic-0 finished in the under 10s bucket in the recording and the under 1s bucket on replay.

## Notes

Wikipedia search is recorded as fill plus Enter. A click on `#searchInput` opens Vector's typeahead, and the field the click found is not the field the next step has to type into.

Move keeps a 1280×720 viewport and only relocates the window. Resize sets an 880×560 viewport. Below about 1120px, Vector collapses `#searchInput` to a 0×0 box and shows a search link. When the recorded target is that collapsed box, replay clicks a recorded or discoverable reveal control (the search toggle) and logs a `reveal` repair, then locates the field that opened. Python docs search and the-internet dynamic loading still have a visible target at 880×560.

Language drift changes the accessible name (Search Wikipedia / Search versus Buscar en Wikipedia / Búsqueda) and leaves the id or the `name` attribute. Primary replays the role locator only. Multi can use the css locator.

`internet-add` / `stale-label` is not a visual mutation of the site. The recorded name is `Add Element now` and the live button is `Add Element`. The label repair is what makes that step pass. Dynamic loading has no second language on this host.