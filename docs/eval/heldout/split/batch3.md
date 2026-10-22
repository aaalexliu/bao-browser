# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 0 true keep steps: none.

Invalid fixtures stay in the table and are not counted as bao misses.

Including invalid fixtures: condense P 0.979 R 1.000 replay 9/12; model P 0.979 R 1.000 replay 9/12; hybrid P 0.979 R 1.000 replay 9/12.

Excluding invalid fixtures: condense P 0.975 R 1.000 replay 9/10; model P 0.975 R 1.000 replay 9/10; hybrid P 0.975 R 1.000 replay 9/10.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note | invalid fixture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mdn-name-form | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-styled-mail | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-get-say | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-postcard | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| httpbingo-topping | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |  |
| jquery-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  | The jQuery TodoMVC demo does not boot, so Enter cannot add an item. 404 jquery.min.js, director.min.js, handlebars.min.js, todomvc-common, and todomvc-app-css. pageerror ReferenceError: jQuery is not defined. #new-todo is in the DOM and Enter leaves the list empty. |
| backbone-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing write tests; body missing ship replay | 0 |  |  | The Backbone TodoMVC demo does not boot, so Enter cannot add an item. 404 backbone-min.js, underscore-min.js, and jquery.min.js. pageerror ReferenceError: Backbone is not defined and jQuery is not defined. .new-todo is in the DOM and Enter leaves the list empty. |
| sqlite-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| eslint-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| jquery-api-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | url missing get; url missing on | 0 |  |  |  |
| bootstrap-email | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| rfc-search | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |  |
| mdn-name-form | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1827 |  |  |
| mdn-styled-mail | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1512 |  |  |
| mdn-get-say | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1189 |  |  |
| mdn-postcard | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1403 |  |  |
| httpbingo-topping | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1505 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |  |
| jquery-todo | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 806 |  | The jQuery TodoMVC demo does not boot, so Enter cannot add an item. 404 jquery.min.js, director.min.js, handlebars.min.js, todomvc-common, and todomvc-app-css. pageerror ReferenceError: jQuery is not defined. #new-todo is in the DOM and Enter leaves the list empty. |
| backbone-todo | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing write tests; body missing ship replay | 0 | 1041 |  | The Backbone TodoMVC demo does not boot, so Enter cannot add an item. 404 backbone-min.js, underscore-min.js, and jquery.min.js. pageerror ReferenceError: Backbone is not defined and jQuery is not defined. .new-todo is in the DOM and Enter leaves the list empty. |
| sqlite-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1464 |  |  |
| eslint-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 949 |  |  |
| jquery-api-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing get; url missing on | 0 | 879 |  |  |
| bootstrap-email | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1488 |  |  |
| rfc-search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1013 |  |  |
| mdn-name-form | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1445 |  |  |
| mdn-styled-mail | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1276 |  |  |
| mdn-get-say | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1321 |  |  |
| mdn-postcard | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1096 |  |  |
| httpbingo-topping | hybrid/groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.40 | pass | 0 | 1364 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |  |
| jquery-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | body missing write tests; body missing ship replay | 0 | 1445 |  | The jQuery TodoMVC demo does not boot, so Enter cannot add an item. 404 jquery.min.js, director.min.js, handlebars.min.js, todomvc-common, and todomvc-app-css. pageerror ReferenceError: jQuery is not defined. #new-todo is in the DOM and Enter leaves the list empty. |
| backbone-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | body missing write tests; body missing ship replay | 0 | 1195 |  | The Backbone TodoMVC demo does not boot, so Enter cannot add an item. 404 backbone-min.js, underscore-min.js, and jquery.min.js. pageerror ReferenceError: Backbone is not defined and jQuery is not defined. .new-todo is in the DOM and Enter leaves the list empty. |
| sqlite-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.33 | pass | 0 | 1116 |  |  |
| eslint-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1403 |  |  |
| jquery-api-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | url missing get; url missing on | 0 | 1414 |  |  |
| bootstrap-email | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1517 |  |  |
| rfc-search | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1210 |  |  |

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
