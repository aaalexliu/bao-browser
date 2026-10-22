# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 0 true keep steps: none.

Replay pass rate: condense 9/12, model 6/12, hybrid 9/12.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mdn-name-form | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-styled-mail | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-get-say | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-postcard | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| httpbingo-topping | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| jquery-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  |
| backbone-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  |
| sqlite-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| eslint-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| jquery-api-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | url missing get; url missing on | 0 |  |  |
| bootstrap-email | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| rfc-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| mdn-name-form | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1268 | extra click/mail/user_mail///#mail/-/-/ ; type/mail/user_mail///#mail/-/username2/; extra defaults Ada LovelacexAda Lovelace,nope |
| mdn-styled-mail | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1115 | extra click/name/user_name///#name/-/-/ ; type/msg/user_message///#msg/-/username2/; extra defaults nope |
| mdn-get-say | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1574 |  |
| mdn-postcard | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | value  != Grace; value  != Lin | 0 | 1174 | missing type/name/user_name///#name/-/username/; extra click////to: Mozilla/form:nth-of-type(1) > h1:nth-of-type(1)/-/-/ ; type/msg/user_message///#msg/-/username/; extra defaults nope |
| httpbingo-topping | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1484 | extra type//comments///form:nth-of-type(1) > p:nth-of-type(5) > label:nth-of-type(1) > textarea:nth-of-type(1)/-/comments/; extra defaults nope |
| jquery-todo | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 1058 |  |
| backbone-todo | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 1050 | extra click////todos/section:nth-of-type(1) > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| sqlite-search | groq/openai/gpt-oss-120b | 1.00 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing pragma; url missing index | 0 | 1106 | missing type/searchbox/q///#searchbox/-/q/ |
| eslint-search | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 965 | extra click////Documentation/#main > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/; extra defaults no-unusedxno-unused |
| jquery-api-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing get; url missing on | 0 | 890 | extra defaults ajaxxajax |
| bootstrap-email | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 |  | value  != grace@example.com; value  != lin@example.com | 0 | 1069 | missing type/exampleInputEmail1////#exampleInputEmail1/-/username/ ; type/exampleInputPassword1////#exampleInputPassword1/login/password/ |
| rfc-search | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1190 | extra click/the-official-home-of-rfcs///The official home of RFCs/#the-official-home-of-rfcs/-/-/; extra defaults httpxhttp |
| mdn-name-form | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1246 |  |
| mdn-styled-mail | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1031 |  |
| mdn-get-say | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1157 |  |
| mdn-postcard | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1193 |  |
| httpbingo-topping | hybrid/groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.60 | pass | 0 | 1461 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| jquery-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | body missing write tests; body missing ship replay | 0 | 1271 |  |
| backbone-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | body missing write tests; body missing ship replay | 0 | 1241 |  |
| sqlite-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1574 |  |
| eslint-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1221 |  |
| jquery-api-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | url missing get; url missing on | 0 | 1309 |  |
| bootstrap-email | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1675 |  |
| rfc-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1350 |  |

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
