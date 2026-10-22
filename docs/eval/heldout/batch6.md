# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 1 true keep steps: internet-keys e5.

Replay pass rate: condense 10/10, model 10/10, hybrid 10/10.

Prejudge lint caught 7/10 known-bad intents on its own (missing input, secret literal, no effect, unknown domain) and falsely rejected 0/24 good intents. Combined with the judge, 7/10 are caught.

Model access: groq / openai/gpt-oss-120b; ping tokens 112.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note | invalid fixture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wiki-portal | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| httpbin-links | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| internet-keys | condense | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | missing click/target////#target/-/-/ |  |
| internet-notify | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| internet-loading | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-input | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-structure | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-beacon | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| internet-float | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Home/#menu > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/-/-/ |  |
| internet-dom | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////delete/#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(7) > a:nth-of-type(2)/-/-/ |  |
| wiki-portal | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1075 |  |  |
| httpbin-links | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1094 |  |  |
| internet-keys | groq/openai/gpt-oss-120b | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1473 | missing click/target////#target/-/-/ |  |
| internet-notify | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 923 |  |  |
| internet-loading | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 940 |  |  |
| mdn-input | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1054 |  |  |
| mdn-structure | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1034 |  |  |
| mdn-beacon | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1052 |  |  |
| internet-float | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 946 | extra click////Home/#menu > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/-/-/ |  |
| internet-dom | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1058 | extra click////delete/#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(7) > a:nth-of-type(2)/-/-/ |  |
| wiki-portal | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1380 |  |  |
| httpbin-links | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1185 |  |  |
| internet-keys | hybrid/groq/openai/gpt-oss-120b | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1171 | missing click/target////#target/-/-/ |  |
| internet-notify | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1094 |  |  |
| internet-loading | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1175 |  |  |
| mdn-input | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1068 |  |  |
| mdn-structure | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1158 |  |  |
| mdn-beacon | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1127 |  |  |
| internet-float | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1287 | extra click////Home/#menu > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/-/-/ |  |
| internet-dom | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1279 | extra click////delete/#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(7) > a:nth-of-type(2)/-/-/ |  |

## Bad intent texts

The prejudge lint runs before the judge. It caught 7/10 known-bad intents on its own. Combined with the judge, 7/10 are caught. 0/24 good intents were falsely rejected. The rubric was not edited.

| id | lint | judge | caught | text |
| --- | --- | --- | --- | --- |
| b1 | missing-input | bad | yes | Click button. |
| b2 | missing-input | bad | yes | Click the button. |
| b3 | missing-input | bad | yes | Do the thing. |
| b4 | secret-literal | bad | yes | Type HeldOutDemoSecret! into the password field. |
| b5 | secret-literal | bad | yes | Type pin-9999 to unlock the account. |
| b6 | secret-literal | bad | yes | Type SuperSecretPassword! and log in. |
| b7 |  | good | no | Delete the search field. |
| b8 |  | good | no | Uncheck subscribe and clear the form. |
| b9 |  | good | no | Type Ada Lovelace into the search box. |
| b10 | no-effect | bad | yes | Open the Help menu. |
