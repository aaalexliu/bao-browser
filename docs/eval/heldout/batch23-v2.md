# Batches 2 and 3 after alerts v2 and the url phrase check

Scored with deterministic condense and replay. No model call. The condenser is unchanged. Batch 4 and batch 5 were not scored.

## alerts

v1 is `batch2/history/alerts.v1.json`. Its alert click has matching urls and no dialog, so condense keeps no step and replay misses `successfully clicked an alert`.

v2 is `batch2/alerts.v2.json`, recorded with the dialog recorder from the same clicks (heading, heading, JS Confirm, JS Alert). The recorder stores two clicks. The confirm click keeps the dialog "I am a JS Confirm" and the result "You clicked: Ok". The alert click keeps "I am a JS Alert" and "You successfully clicked an alert". Ground truth still keeps only the alert click. Condense also keeps the confirm click, because that click now has an effect, and the button name matches confirm.

| case | before | after |
| --- | --- | --- |
| alerts condense | P 0.00 R 0.00 replay miss | P 0.50 R 1.00 replay pass |
| batch 2 condense replay | 11/12 | 12/12 |
| effect filter dropped keep steps | alerts e6 | none |

The other eleven batch 2 condense rows match `batch2-rescore.md`.

## url phrase

hn-search replay reaches `https://hn.algolia.com/?q=Grace+Hopper` and `https://hn.algolia.com/?q=Alan+Turing`. Both step replays pass. The oracle asks the URL to contain `Grace Hopper` or `Alan Turing`. The raw URL does not. The check now also accepts the decoded query value.

Batch 3 condense, compared with `batch3-rescore.md`:

| | before | after |
| --- | --- | --- |
| including invalid fixtures | P 0.979 R 1.000 replay 9/12 | P 0.979 R 1.000 replay 9/12 |
| excluding invalid fixtures | P 0.975 R 1.000 replay 9/10 | P 0.975 R 1.000 replay 9/10 |

`jquery-api-search` stays `url missing get; url missing on`. The url check did not move the batch 2 or batch 3 numbers. The batch 2 replay change is the alerts trail.
