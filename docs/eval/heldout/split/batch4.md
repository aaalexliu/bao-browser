# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 0 true keep steps: none.

Replay pass rate: condense 12/12, model 12/12, hybrid 12/12.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note | invalid fixture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| selenium-greeting | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| selenium-confirm | condense | 1.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| selenium-agree | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| hockey-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| caniuse-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| sauce-username | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| globalsqa-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| bulma-text | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| parabank-username | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| webscraper-laptop | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| htmx-edit | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| playwright-locators | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| selenium-greeting | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1747 |  |  |
| selenium-confirm | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1205 |  |  |
| selenium-agree | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1088 |  |  |
| hockey-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1125 |  |  |
| caniuse-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1151 |  |  |
| sauce-username | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1263 |  |  |
| globalsqa-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1123 |  |  |
| bulma-text | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1323 |  |  |
| parabank-username | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1222 |  |  |
| webscraper-laptop | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1041 |  |  |
| htmx-edit | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1227 |  |  |
| playwright-locators | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1022 |  |  |
| selenium-greeting | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1266 |  |  |
| selenium-confirm | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1097 |  |  |
| selenium-agree | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1172 |  |  |
| hockey-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1374 |  |  |
| caniuse-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1325 |  |  |
| sauce-username | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1387 |  |  |
| globalsqa-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.00 | pass | 0 | 1212 |  |  |
| bulma-text | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1389 |  |  |
| parabank-username | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1517 |  |  |
| webscraper-laptop | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1222 |  |  |
| htmx-edit | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1175 |  |  |
| playwright-locators | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1139 |  |  |

## Bad intent texts

Lint runs before the judge. 10/10 bad texts were caught. 0/24 good intents were falsely rejected. The rubric was not edited.

| id | lint | judge | caught | text |
| --- | --- | --- | --- | --- |
| b1 | generic | bad | yes | Click button. |
| b2 | generic | bad | yes | Click the button. |
| b3 | generic | bad | yes | Do the thing. |
| b4 | secret | bad | yes | Type HeldOutDemoSecret! into the password field. |
| b5 | secret | bad | yes | Type pin-9999 to unlock the account. |
| b6 | secret | bad | yes | Type SuperSecretPassword! and log in. |
| b7 | destructive | bad | yes | Delete the search field. |
| b8 | destructive | bad | yes | Uncheck subscribe and clear the form. |
| b9 | literal | bad | yes | Type Ada Lovelace into the search box. |
| b10 | help | bad | yes | Open the Help menu. |
