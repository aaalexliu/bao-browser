# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, or subtree change and no later step sits in its subtree. A Help click is kept.

Effect filter wrongly dropped 0 true keep steps: none.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mdn-name-form | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-styled-mail | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-get-say | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | url missing Hello; url missing Bye | 0 |  |  |
| mdn-postcard | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| httpbingo-topping | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| jquery-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  |
| backbone-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  |
| sqlite-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| eslint-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| jquery-api-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | url missing get; url missing on | 0 |  |  |
| bootstrap-email | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| rfc-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | postcondition; postcondition | 0 |  |  |
| mdn-name-form | groq/openai/gpt-oss-120b | 0.40 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1629 | extra click/mail/user_mail///#mail/-/-/ ; key//////-/-/Backspace ; type/name/user_name///#name/-/username2/; extra defaults Ada Lovelacex |
| mdn-styled-mail | groq/openai/gpt-oss-120b | 0.33 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing my-handling-form-page; url missing my-handling-form-page | 0 | 1327 | missing click////Send your message/form:nth-of-type(1) > p:nth-of-type(4) > button:nth-of-type(1)/-/-/; extra click/name/user_name///#name/-/-/ ; type/msg/user_message///#msg/-/username2/; extra defaults ada@example.comxada@example.com,nope |
| mdn-get-say | groq/openai/gpt-oss-120b | 1.00 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing Hello; url missing Bye | 0 | 1280 | missing type/say/say///#say/-/say/ |
| mdn-postcard | groq/openai/gpt-oss-120b | 0.33 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1008 | extra click////to: Mozilla/form:nth-of-type(1) > h1:nth-of-type(1)/-/-/ ; type/msg/user_message///#msg/-/username2/; extra defaults AdxAda,nope |
| httpbingo-topping | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing grace@example.com; body missing lin@example.com | 0 | 1006 | missing type//custemail///form:nth-of-type(1) > p:nth-of-type(3) > label:nth-of-type(1) > input:nth-of-type(1)/-/username/ ; check//topping///form:nth-of-type(1) > fieldset:nth-of-type(2) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| jquery-todo | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 1117 | extra click////todos/#header > h1:nth-of-type(1)/-/-/ |
| backbone-todo | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 1043 | extra click////todos/section:nth-of-type(1) > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| sqlite-search | groq/openai/gpt-oss-120b | 0.33 | 0.50 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1460 | missing click/////#searchmenu > form:nth-of-type(1) > input:nth-of-type(2)/-/-/; extra click////About/div:nth-of-type(1) > div:nth-of-type(3) > ul:nth-of-type(1) > li:nth-of-type(3) > a:nth-of-type(1)/-/-/ ; click/////#searchmenu > form:nth-of-type(1) > input:nth-of-type(2)/confirm/-/ |
| eslint-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 992 |  |
| jquery-api-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing get; url missing on | 0 | 1124 |  |
| bootstrap-email | groq/openai/gpt-oss-120b | 0.43 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | value  != grace@example.com; value  != lin@example.com | 0 | 1249 | extra click/content///Forms/#content/-/-/ ; click/content///Forms/#content/-/-/ ; key//////-/-/Backspace ; type/exampleInputEmail1////#exampleInputEmail1/-/username2/; extra defaults ada@example.comx |
| rfc-search | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | postcondition; postcondition | 0 | 1160 | extra click/the-official-home-of-rfcs///The official home of RFCs/#the-official-home-of-rfcs/-/-/ |
| mdn-name-form | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1275 |  |
| mdn-styled-mail | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1097 |  |
| mdn-get-say | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | url missing Hello; url missing Bye | 0 | 1398 |  |
| mdn-postcard | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1148 |  |
| httpbingo-topping | hybrid/groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.60 | pass | 0 | 1465 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| jquery-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | body missing write tests; body missing ship replay | 0 | 1222 |  |
| backbone-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | body missing write tests; body missing ship replay | 0 | 1235 |  |
| sqlite-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.33 | pass | 0 | 1066 |  |
| eslint-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1223 |  |
| jquery-api-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | url missing get; url missing on | 0 | 1255 |  |
| bootstrap-email | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1538 |  |
| rfc-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | postcondition; postcondition | 0 | 1145 |  |

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
