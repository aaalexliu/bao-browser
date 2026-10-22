# Why the model-only condenser lands at 6 to 8 of 12

These are the model rows in the frozen score files. The condenser was not changed to chase them.

## 1. The keep click or type is dropped

The model omits the action the ground truth keeps, so replay never reaches the page the oracle checks.

- Batch 5 `markdown-cheat`: missing the Cheat Sheet click. Replay is `url missing /cheat-sheet/`.
- Batch 5 `lua-manual`: missing the manual click. Replay is `url missing manual.html`.
- Batch 5 `rust-vec`: missing the Vec click (and a second Vec click is tagged confirm). Replay is `below-threshold`.
- Batch 2 `quotes-author`: missing the author click. Replay is `url missing /author/Albert-Einstein`.

## 2. A mis-click is kept and tagged as a human gate

The model keeps a noise click and marks it login or confirm. Replay then stops on that control.

- Batch 5 `git-add`: the About link is an extra click tagged login. Replay is `below-threshold`.
- Batch 5 `node-synopsis`: the kept click is retagged confirm, and the real Usage click is also reported missing. Replay happens to pass on one reading of the url and still scores step recall 0.
- Batch 5 `pico-email`: an extra click on the Forms heading is tagged login. The secret still passes, and model human recall for that row is 0.
- Batch 3 `backbone-todo`: an extra click on the todos heading. The body oracle misses because the app is an invalid fixture, which is a separate column.

## 3. The typo and the correction are both kept

The model treats the wiped value as a real input, so the param does not match and replay types the wrong text or misses the field.

- Batch 5 `hn-search`: missing the type into `q`, with an extra comments click. Replay is `no-candidates`.
- Batch 5 `musicbrainz-search`: extra defaults `BeatlessBeatles` and param recall 0. Replay still passes.
- Batch 3 `jquery-api-search`: extra defaults `ajaxxajax` and param recall 0. Replay is `url missing get`.
