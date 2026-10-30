# Intent eval

Model access: groq / openai/gpt-oss-120b; ping tokens 112.

Judge calibration on 10 hand labels: 10/10 agree. Calibration tokens 918.

The condenser `condense` is deterministic and calls no model. The model condenser edits the raw trail. `hybrid` starts from `condense`: the model may drop a Help step, write a summary and per-step intent, and flag human steps. Unknown ids are ignored. A drop is refused when the step has an input, a gate, a secret tag, or a text, url, or value postcondition. Intent text is scrubbed of secret literals and of captured defaults. Hybrid human precision and recall are the gates condense already set. Model human on a hybrid row is the flags the model returned, matched by target. Judge scores the hybrid intent text from 0 to 1. Step precision and recall compare workflow steps with the ground-truth steps. A Help click is left in the deterministic trail on purpose. Param recall is typed values, literal currency or unit values, and secret and file inputs. Secret is 0 if a secret literal survived in the workflow. Replay is two runs with new inputs. Model calls are heal calls during those replays. Hybrid tokens include the judge call.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| save-name | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| email-note | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| login | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| confirm-delete | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| upload-title | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| terms | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| tabs | condense | 0.80 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| search | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| scroll-row | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| dialog | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| pay | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| pin | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| color | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| profile | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| drop-file | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| signup | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| long-abort | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| tabs-mix | condense | 0.88 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| fare | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| save-name | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1282 |  |
| email-note | groq/openai/gpt-oss-120b | 1.00 | 0.67 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | email-note; email-note | 0 | 2558 |  |
| login | groq/openai/gpt-oss-120b | 1.00 | 0.67 | 0.50 | 1.00 | 1.00 | 0.50 | 0.50 | 1.00 |  | login; login | 0 | 1268 |  |
| confirm-delete | groq/openai/gpt-oss-120b | 0.50 | 0.33 | 0.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 |  | confirm-delete; confirm-delete | 0 | 1791 |  |
| upload-title | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1461 |  |
| terms | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1026 |  |
| tabs | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1968 |  |
| search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1342 |  |
| scroll-row | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1384 |  |
| dialog | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1982 |  |
| pay | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 |  | pass | 0 | 963 |  |
| pin | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 0.50 | 1.00 | 0.33 | 1.00 | 0.00 | 1.00 |  | pin; pin | 0 | 2256 |  |
| color | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 2022 |  |
| profile | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | profile; profile | 0 | 1930 |  |
| drop-file | groq/openai/gpt-oss-120b | 0.29 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1172 |  |
| signup | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1454 |  |
| long-abort | groq/openai/gpt-oss-120b | 0.14 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 2055 |  |
| tabs-mix | groq/openai/gpt-oss-120b | 1.00 | 0.71 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 2138 |  |
| fare | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1823 |  |
| save-name | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1154 |  |
| email-note | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1432 |  |
| login | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1699 |  |
| confirm-delete | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1432 |  |
| upload-title | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1296 |  |
| terms | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1281 |  |
| tabs | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1430 |  |
| search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1130 |  |
| scroll-row | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1339 |  |
| dialog | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1263 |  |
| pay | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1422 |  |
| pin | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1407 |  |
| color | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1284 |  |
| profile | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1380 |  |
| drop-file | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1144 |  |
| signup | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1720 |  |
| long-abort | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1353 |  |
| tabs-mix | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1811 |  |
| fare | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1634 |  |

## Judge calibration

Hand labels are fixed in `desktop/src/eval/intent/labels.ts`. The judge does not see the good column.

| id | hand | judge | match |
| --- | --- | --- | --- |
| l1 | good | good | yes |
| l2 | good | good | yes |
| l3 | bad | bad | yes |
| l4 | bad | bad | yes |
| l5 | good | good | yes |
| l6 | bad | bad | yes |
| l7 | good | good | yes |
| l8 | good | good | yes |
| l9 | bad | bad | yes |
| l10 | good | good | yes |
