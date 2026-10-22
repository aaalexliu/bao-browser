# Remaining misses in frozen batches 2 and 3

Batches 2, 3, and 4 stay frozen. These four replays were traced from the committed trails and from the live pages on 22 Oct 2026. The condenser and the locator scorer were left unchanged. Batch 4 was not used to tune them.

## Batch 2, `alerts`

The keep step is `e6`, the click on "Click for JS Alert". The frozen trail records a button with a css path, `beforeUrl` and `afterUrl` both `https://the-internet.herokuapp.com/javascript_alerts`, and no dialog, subtree, value, or checked field. The heading clicks (`e3`, `e4`) and "Click for JS Confirm" (`e5`) have that same shape. `e4` is a repeat of `e3`, so the retry collapse removes it. The effect filter then drops `e3`, `e5`, and `e6`. The condensed workflow has no steps, step precision and recall are 0, and replay never clicks the button.

Loading the page and accepting the dialog writes `You successfully clicked an alert` into `#result`. The frozen trail never stored that text or the dialog, so the effect filter has no effect to keep. The trail stays as captured. Keeping every effect-less button click would also keep the heading and confirm clicks that the ground truth marks as noise.

## Batch 3, `jquery-todo` and `backbone-todo`

Both condense to the kept type plus Enter. Step precision and recall are 1.00. The Enter events have no identity. Replay types the new text and presses Enter. The oracle asks the body to include that text (`write tests`, then `ship replay`).

The jQuery example does not boot. Its scripts 404 (`jquery.min.js`, `director.min.js`, `handlebars.min.js`, and the TodoMVC common files) and the page raises `jQuery is not defined`. `#new-todo` is in the DOM. Filling it and pressing Enter leaves the list empty.

The Backbone example 404s `backbone-min.js`, `underscore-min.js`, and `jquery.min.js`, and raises `Backbone is not defined` and `jQuery is not defined`. `.new-todo` is in the DOM. Enter does not add the item.

The body oracle cannot pass while those apps do not create an item. The steps match the ground truth.

## Batch 3, `jquery-api-search`

The trail condenses to typing `ajax` into `input[name=s]` and pressing Enter. The type and the Enter both record `https://api.jquery.com/` as `beforeUrl` and `afterUrl`. Replay with `get` and `on` stays on that url, so the url oracle misses. Enter in the typesense search box does not navigate. The frozen trail already shows that, and the oracle stays as recorded. Step precision and recall are 1.00.

## jquery-api-search and hn-search

Replay video frames for both, plus the condensed expects:

- `hn-search` submits. The condensed key step expects `q={{q}}`. Replay with Grace Hopper finishes at `https://hn.algolia.com/?q=Grace+Hopper` with a results list that names Grace Hopper (258 results). The step expect holds. The held-out page oracle asks the url to contain the phrase `Grace Hopper`, and the url contains `Grace+Hopper`.
- `jquery-api-search` submits. The field shows `get` and a `.tsmb-suggestion_group` lists `jQuery.get()`. The url stays `https://api.jquery.com/`. The frozen Enter event has equal urls and no subtree, so expect is `settled`, not a url template. The page oracle asks the url to include `get`.

Neither miss is a replay that never submitted the query. Expect inference is using the effect the frozen trail recorded. The trails were not edited, and expect inference was not changed. Batch 5 stays at its scored result.
