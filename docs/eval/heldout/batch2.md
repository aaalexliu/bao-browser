# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Deterministic, model-only, and hybrid ran with no condenser changes in between. Numbers below are that run.

Model access: groq / openai/gpt-oss-120b; ping tokens 112.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| httpbin-order | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| status-200 | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Status Codes/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| redirect | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Redirection/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| quotes-author | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | tie; tie | 0 |  | extra click////Quotes to Scrape/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| quotes-tag | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | tie; tie | 0 |  |  |
| quotes-login | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | below-threshold; below-threshold | 0 |  | extra click////Quotes to Scrape/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| books-travel | condense | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  |  |
| w3c-shipping | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check/check_1/newsletter///#check_1/-/-/ |
| w3c-check | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra check/check_2/company_offers///#check_2/-/-/ |
| mdn-button | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////<button> HTML button element/#content > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| alerts | condense | 0.33 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 |  |  |  | pass | 0 |  | extra click////JavaScript Alerts/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////Click for JS Confirm/#content > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(2) > button:nth-of-type(1)/confirm/-/ |
| playwright-todo | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | below-threshold; below-threshold | 0 |  | extra click////todos/section:nth-of-type(1) > div:nth-of-type(1) > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| httpbin-order | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1490 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ ; type//comments///form:nth-of-type(1) > p:nth-of-type(5) > label:nth-of-type(1) > textarea:nth-of-type(1)/-/comments/; extra defaults nope |
| status-200 | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 902 |  |
| redirect | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 907 | extra click////Redirection/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| quotes-author | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing /author/Albert-Einstein; url missing /author/Albert-Einstein | 0 | 884 | missing click////(about)/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(2) > a:nth-of-type(1)/-/-/; extra click////deep-thoughts/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(2)/-/-/ |
| quotes-tag | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | no-candidates; no-candidates | 0 | 910 | missing click////inspirational/div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > div:nth-of-type(3) > div:nth-of-type(1) > a:nth-of-type(1)/-/-/; extra click////Login/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(2) > p:nth-of-type(1) > a:nth-of-type(1)/-/-/ ; click//////-/-/ |
| quotes-login | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 0.00 | 1.00 | 0.50 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1213 | missing type/username/username///#username/-/username/ ; type/password/password///#password/login/password/ |
| books-travel | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing travel_2; url missing travel_2 | 0 | 920 | missing click////Travel/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > aside:nth-of-type(1) > div:nth-of-type(2) > ul:nth-of-type(1) > li:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/-/-/ |
| w3c-shipping | groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | value  != Grace; value  != Lin | 0 | 1295 | extra check/check_1/newsletter///#check_1/-/-/ ; type/header-search/q/Search//#header-search/-/q/; extra defaults nope |
| w3c-check | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 960 |  |
| mdn-button | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 822 |  |
| alerts | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | body missing successfully clicked an alert; body missing successfully clicked an alert | 0 | 806 | missing click////Click for JS Alert/#content > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > button:nth-of-type(1)/-/-/; extra click////JavaScript Alerts/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| playwright-todo | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1200 | extra click////todos/section:nth-of-type(1) > div:nth-of-type(1) > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| httpbin-order | hybrid/groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1444 | extra check//size///form:nth-of-type(1) > fieldset:nth-of-type(1) > p:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)/-/-/ |
| status-200 | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1178 | extra click////Status Codes/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| redirect | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1250 | extra click////Redirection/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| quotes-author | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | tie; tie | 0 | 1189 | extra click////Quotes to Scrape/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| quotes-tag | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | tie; tie | 0 | 1095 |  |
| quotes-login | hybrid/groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | below-threshold; below-threshold | 0 | 1884 | extra click////Quotes to Scrape/div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| books-travel | hybrid/groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1082 |  |
| w3c-shipping | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1218 | extra check/check_1/newsletter///#check_1/-/-/ |
| w3c-check | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1349 | extra check/check_2/company_offers///#check_2/-/-/ |
| mdn-button | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1101 | extra click////<button> HTML button element/#content > div:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |
| alerts | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1458 | extra click////JavaScript Alerts/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////Click for JS Confirm/#content > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(2) > button:nth-of-type(1)/confirm/-/ |
| playwright-todo | hybrid/groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | below-threshold; below-threshold | 0 | 1272 | extra click////todos/section:nth-of-type(1) > div:nth-of-type(1) > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ |

## Bad intent texts

The judge scored 10 texts written to be bad. 5/10 came back bad (low). The rubric was not edited, and these texts were not added to the calibration set. A concrete wrong verb or a non-secret value can still score good under that rubric.

| id | judge | low | text |
| --- | --- | --- | --- |
| b1 | good | no | Click button. |
| b2 | good | no | Click the button. |
| b3 | bad | yes | Do the thing. |
| b4 | bad | yes | Type HeldOutDemoSecret! into the password field. |
| b5 | bad | yes | Type pin-9999 to unlock the account. |
| b6 | bad | yes | Type SuperSecretPassword! and log in. |
| b7 | good | no | Delete the search field. |
| b8 | good | no | Uncheck subscribe and clear the form. |
| b9 | good | no | Type Ada Lovelace into the search box. |
| b10 | bad | yes | Open the Help menu. |
