# Model condenser rules, scored on a held-out split

The model prompt and `reviseDecision` enforce three trail rules. They do not name a fixture.

1. Never drop a step whose effect a later step depends on. A click that opened the page, a click whose control contains a later step, and a type whose value a later key or submit uses all stay. The last click, type, or key that still has an effect stays.
2. Never mark a click as login or confirm when it changed nothing. A click undone by Back is dropped and cannot be a gate. Login is a password, a pin, or a Log in or Sign in click. Confirm is a Confirm click.
3. A value wiped with Backspace and retyped on the same field keeps only the final value.

The split is `heldoutSplit` in `desktop/src/eval/heldout/split.ts`: FNV-1a of the case id, even is test. It was fixed before this run. Dev was not used to edit the rules after the scores below, and the test half was not used at all.

Invalid fixtures (`jquery-todo`, `backbone-todo`) stay in the batch 3 table and are left out of the split averages. They are not bao misses.

Before is the frozen score file for that batch (`batch2-rescore.md`, `batch3-rescore.md`, `batch4.md`, `batch5.md`). After is `docs/eval/heldout/split/`. Model is `groq/openai/gpt-oss-120b`. Hybrid step precision, recall, and replay did not move. The gate rule only filters human flags the model adds on the deterministic workflow.

## By batch

| batch | model before | model after | hybrid before and after |
| --- | --- | --- | --- |
| 2 | P 0.694 R 0.777 replay 8/12 | P 0.820 R 0.917 replay 10/12 | P 0.806 R 0.917 replay 11/12 |
| 3, with invalid | P 0.772 R 0.889 replay 7/12 | P 0.979 R 1.000 replay 9/12 | P 0.979 R 1.000 replay 9/12 |
| 3, valid only | P 0.759 R 0.867 replay 7/10 | P 0.975 R 1.000 replay 9/10 | P 0.975 R 1.000 replay 9/10 |
| 4 | P 0.639 R 0.667 replay 7/12 | P 1.000 R 1.000 replay 12/12 | P 1.000 R 1.000 replay 12/12 |
| 5 | P 0.383 R 0.625 replay 6/12 | P 0.857 R 1.000 replay 10/12 | P 1.000 R 1.000 replay 11/12 |

## Held-out split, valid fixtures

23 dev cases and 23 test cases.

| split | model before | model after | hybrid before and after |
| --- | --- | --- | --- |
| dev | P 0.710 R 0.870 replay 16/23 | P 0.950 R 1.000 replay 21/23 | P 0.942 R 1.000 replay 22/23 |
| test | P 0.515 R 0.587 replay 12/23 | P 0.871 R 0.957 replay 20/23 | P 0.946 R 0.957 replay 21/23 |

## What is still open

The test half was not edited after these rows.

- `alerts` (test). The frozen trail still has no dialog or text effect. The model kept the "JavaScript Alerts" heading and dropped the button. Replay misses the result text. Condense drops that button too.
- `hn-search` (test) and `jquery-api-search` (dev). Step precision, recall, and param recall are 1. Replay still misses the result url. That is the oracle reading the results list as a url, which this change does not touch.
- `node-synopsis` and `markdown-cheat` (test). Recall is 1, so the goal click is kept. Precision is 0.14 because several unnamed clicks stay. `markdown-cheat` replay passes. `node-synopsis` replay is `no-candidates`.
- Dev residuals that replay: `playwright-todo` keeps one extra unnamed click and replay is `no-candidates`. `w3c-check` and `httpbin-order` keep an extra check and replay passes. `httpbingo-topping` (test) keeps the same extra size check condense keeps, and replay passes.
