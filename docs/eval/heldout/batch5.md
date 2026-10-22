# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 0 true keep steps: none.

Replay pass rate: condense 11/12, model 6/12, hybrid 11/12.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hn-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | url missing Grace Hopper; url missing Alan Turing | 0 |  |  |
| gutenberg-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| musicbrainz-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| git-add | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| rust-vec | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| node-synopsis | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| markdown-cheat | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| pptr-api | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| httpwg-semantics | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| nginx-core | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| pico-email | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| lua-manual | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| hn-search | groq/openai/gpt-oss-120b | 0.25 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | no-candidates; no-candidates | 0 | 1718 | missing type//q///#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(4) > td:nth-of-type(1) > center:nth-of-type(2) > form:nth-of-type(1) > input:nth-of-type(1)/-/q/; extra click////comments/#hnmain > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(1) > td:nth-of-type(2) > span:nth-of-type(1) > a:nth-of-type(3)/-/-/ ; click// |
| gutenberg-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 896 |  |
| musicbrainz-search | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1055 | extra click////Search/#content > h1:nth-of-type(1)/-/-/; extra defaults BeatlessBeatles |
| git-add | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1111 | extra click////About/#sidebar > nav:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/login/-/ |
| rust-vec | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1089 | missing click////Vec<T>/#main-content > details:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1) > a:nth-of-type(2)/-/-/; extra click////Option<T>/#main-content > details:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1) > a:nth-of-type(3)/login/-/ ; click////Vec<T>/#main-content > details:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1) > a:nth-of-type(2)/confirm/-/ |
| node-synopsis | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1083 | missing click////Usage and example/#column2 > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)/-/-/; extra click////Usage and example/#column2 > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)/confirm/-/ |
| markdown-cheat | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing /cheat-sheet/; url missing /cheat-sheet/ | 0 | 812 | missing click////Cheat Sheet/#navbarNavAltMarkup > div:nth-of-type(1) > a:nth-of-type(2)/-/-/ |
| pptr-api | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1034 | extra click////Docs/#__docusaurus > nav:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(2)/-/-/ |
| httpwg-semantics | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 949 | extra click////HTTP Caching/#col1 > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)/-/-/ |
| nginx-core | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1249 | extra click////faq/#menu > nav:nth-of-type(1) > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(9) > a:nth-of-type(1)/-/-/ |
| pico-email | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 0.50 | 1.00 | 0.00 | 1.00 |  | pass | 0 | 1100 | extra click////Forms overview/main:nth-of-type(1) > hgroup:nth-of-type(1) > h1:nth-of-type(1)/login/-/ |
| lua-manual | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing manual.html; url missing manual.html | 0 | 1222 | missing click////start/div:nth-of-type(1) > a:nth-of-type(1)/-/-/ |
| hn-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | url missing Grace Hopper; url missing Alan Turing | 0 | 1275 |  |
| gutenberg-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1271 |  |
| musicbrainz-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1337 |  |
| git-add | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1028 |  |
| rust-vec | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1040 |  |
| node-synopsis | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1167 |  |
| markdown-cheat | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1040 |  |
| pptr-api | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1129 |  |
| httpwg-semantics | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1131 |  |
| nginx-core | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1174 |  |
| pico-email | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.33 | pass | 0 | 1312 |  |
| lua-manual | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1115 |  |

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
