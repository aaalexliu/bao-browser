# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.

A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.

Effect filter wrongly dropped 1 true keep steps: alerts e6.

Replay pass rate: condense 11/12, model 8/12, hybrid 11/12.

Intent lint caught 10/10 bad texts and falsely rejected 0/24 good intents.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. lint rejected every bad text before the model.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| httpbin-order | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| status-200 | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| redirect | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| quotes-author | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| quotes-tag | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| quotes-login | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| books-travel | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| w3c-shipping | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check/check_1/newsletter///#check_1/-/-/ |
| w3c-check | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check/check_2/company_offers///#check_2/-/-/ |
| mdn-button | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| alerts | condense | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | body missing successfully clicked an alert; body missing successfully clicked an alert | 0 |  | missing click////Click for JS Alert/#content > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > button:nth-of-type(1)/-/-/ |
| playwright-todo | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| httpbin-order | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1147 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ ; type//comments///form:nth-of-type(1) > p:nth-of-type(5) > label:nth-of-type(1) > textarea:nth-of-type(1)/-/comments/; extra defaults Ada LovelacexAda Lovelace,nope |
| status-200 | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 996 |  |
| redirect | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 768 |  |
| quotes-author | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing /author/Albert-Einstein; url missing /author/Albert-Einstein | 0 | 812 | missing click////(about)/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(2) > a:nth-of-type(1)/-/-/; extra click////deep-thoughts/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(2)/-/-/ |
| quotes-tag | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | /login; url missing /tag/inspirational/ | 0 | 785 | missing click////inspirational/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(3) > div:nth-of-type(1) > a:nth-of-type(1)/-/-/; extra click////Login/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > p:nth-of-type(1) > a:nth-of-type(1)/-/-/ |
| quotes-login | groq/openai/gpt-oss-120b | 0.50 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 |  | body missing Logout; body missing Logout | 0 | 1597 | missing type/password/password///#password/login/password/ ; click/////div:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(2)/login/-/; extra click////Quotes to Scrape/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/; extra defaults adax |
| books-travel | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 869 |  |
| w3c-shipping | groq/openai/gpt-oss-120b | 0.33 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | value  != Grace; value  != Lin | 0 | 1088 | extra check/check_1/newsletter///#check_1/-/-/ ; type/header-search/q/Search//#header-search/-/q/; extra defaults nope,AdxAda |
| w3c-check | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 995 |  |
| mdn-button | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 907 |  |
| alerts | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 762 |  |
| playwright-todo | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1028 |  |
| httpbin-order | hybrid/groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.75 | pass | 0 | 1506 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| status-200 | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1019 |  |
| redirect | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 960 |  |
| quotes-author | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | pass | 0 | 1161 |  |
| quotes-tag | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1112 |  |
| quotes-login | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.25 | pass | 0 | 1725 |  |
| books-travel | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1083 |  |
| w3c-shipping | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1306 | extra check/check_1/newsletter///#check_1/-/-/ |
| w3c-check | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.00 | pass | 0 | 1050 | extra check/check_2/company_offers///#check_2/-/-/ |
| mdn-button | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1104 |  |
| alerts | hybrid/groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.00 | body missing successfully clicked an alert; body missing successfully clicked an alert | 0 | 809 | missing click////Click for JS Alert/#content > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > button:nth-of-type(1)/-/-/ |
| playwright-todo | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.67 | pass | 0 | 1250 |  |

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
