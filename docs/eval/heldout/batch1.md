# Held-out intent

Trails were captured from public pages and the ground truth was committed before this run. Deterministic, model-only, and hybrid ran with no condenser changes in between. Numbers below are that run.

Model access: groq / openai/gpt-oss-120b; ping tokens 112. bad-text judge keys: l1, l2, l3, l4, l5, l6, l7, l8, l9, l10.

Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wiki-search | condense | 0.17 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | no-candidates; no-candidates | 0 |  | missing type//search/Search Wikipedia//#searchform > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/search/; extra click////Talk/#ca-talk > a:nth-of-type(1)/-/-/ ; click//////-/-/ ; type/searchInput/search/Search Wikipedia//#searchInput/-/search/ ; key//////-/-/Backspace; extra defaults Ada Lovelacex |
| w3c-form | condense | 0.22 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | value  != Grace; value  != Lin | 0 |  | extra type/header-search/q/Search//#header-search/-/q/ ; key//////-/-/Backspace ; key//////-/-/Backspace ; key//////-/-/Backspace; extra defaults nope,Adx |
| mdn-form-link | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | no-candidates; no-candidates | 0 |  | extra click////<dt>/#main-sidebar > nav:nth-of-type(1) > div:nth-of-type(2) > ol:nth-of-type(1) > li:nth-of-type(11) > details:nth-of-type(1) > ol:nth-of-type(1) > li:nth-of-type(35) > a:nth-of-type(1)/-/-/ ; click//////-/-/ |
| login | condense | 0.43 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Login Page/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; click////Login Page/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type/username/username///#username/-/username2/; extra defaults tomsmithh |
| upload | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | postcondition; postcondition | 0 |  | extra click/file-submit////#file-submit/-/-/ ; click//////-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| dynamic-controls | condense | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Enable/#input-example > button:nth-of-type(1)/-/-/ |
| windows | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Opening a new window/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////Opening a new window/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| inputs | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | below-threshold; below-threshold | 0 |  | extra key//////-/-/Backspace ; type/////#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/text2/; extra defaults 42x |
| forgot-password | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | pass | 0 |  | extra click////Forgot Password/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; click////Forgot Password/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type/email/email///#email/-/username2/; extra defaults ada@example.comx |
| add-element | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | postcondition; postcondition | 0 |  | extra click////Add Element/#content > div:nth-of-type(1) > button:nth-of-type(1)/-/-/ ; click////Delete/#elements > button:nth-of-type(1)/-/-/ |
| todo | condense | 0.29 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-bao-i="22"]')
    - locator resolved to <a class="" data-bao-i="22" href="#/completed">Completed</; locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-bao-i="22"]')
    - locator resolved to <a class="" data-bao-i="22" href="#/completed">Completed</ | 0 |  | extra click////todos/#root > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type///New Todo Input//#root > header:nth-of-type(1) > input:nth-of-type(1)/-/text2/ ; click////Completed/#root > footer:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(3) > a:nth-of-type(1)/-/-/; extra defaults buy milkx |
| checkboxes | condense | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  |  | below-threshold; below-threshold | 0 |  | extra check/////#checkboxes > input:nth-of-type(2)/-/-/ ; check/////#checkboxes > input:nth-of-type(2)/-/-/ |
| wiki-search | groq/openai/gpt-oss-120b | 1.00 | 0.50 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | tie; tie | 0 | 1082 | missing type//search/Search Wikipedia//#searchform > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/search/ |
| w3c-form | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1212 |  |
| mdn-form-link | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | url missing /Elements/input; url missing /Elements/input | 0 | 832 | missing click////<input>/#content > div:nth-of-type(2) > section:nth-of-type(3) > dl:nth-of-type(1) > dd:nth-of-type(2) > ul:nth-of-type(1) > li:nth-of-type(2) > a:nth-of-type(1)/-/-/; extra click////<dt>/#main-sidebar > nav:nth-of-type(1) > div:nth-of-type(2) > ol:nth-of-type(1) > li:nth-of-type(11) > details:nth-of-type(1) > ol:nth-of-type(1) > li:nth-of-type(35) > a:nth-of-type(1)/-/-/ |
| login | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 0.50 | 1.00 | 0.67 | 1.00 | 0.50 | 1.00 |  | pass | 0 | 1620 | extra click////Login Page/#content > div:nth-of-type(1) > h2:nth-of-type(1)/login/-/; extra defaults tomsmithhtomsmith |
| upload | groq/openai/gpt-oss-120b | 0.40 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | no-candidates; no-candidates | 0 | 1114 | extra click//////-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| dynamic-controls | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 887 |  |
| windows | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 854 |  |
| inputs | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 0.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 1348 | missing type/////#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/text/; extra type/////#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/login/password/ |
| forgot-password | groq/openai/gpt-oss-120b | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1287 | extra click////Forgot Password/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ |
| add-element | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 762 | extra click////Add Element/#content > div:nth-of-type(1) > button:nth-of-type(1)/-/-/ |
| todo | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | pass | 0 | 1228 | extra click////todos/#root > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ ; click////All/#root > footer:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)/-/-/ |
| checkboxes | groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | below-threshold; below-threshold | 0 | 771 | extra check/////#checkboxes > input:nth-of-type(2)/-/-/ |
| wiki-search | hybrid/groq/openai/gpt-oss-120b | 0.17 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.86 | no-candidates; no-candidates | 0 | 1764 | missing type//search/Search Wikipedia//#searchform > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/search/; extra click////Talk/#ca-talk > a:nth-of-type(1)/-/-/ ; click//////-/-/ ; type/searchInput/search/Search Wikipedia//#searchInput/-/search/ ; key//////-/-/Backspace; extra defaults Ada Lovelacex |
| w3c-form | hybrid/groq/openai/gpt-oss-120b | 0.22 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | value  != Grace; value  != Lin | 0 | 2049 | extra type/header-search/q/Search//#header-search/-/q/ ; key//////-/-/Backspace ; key//////-/-/Backspace ; key//////-/-/Backspace; extra defaults nope,Adx |
| mdn-form-link | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.50 | no-candidates; no-candidates | 0 | 1521 | extra click////<dt>/#main-sidebar > nav:nth-of-type(1) > div:nth-of-type(2) > ol:nth-of-type(1) > li:nth-of-type(11) > details:nth-of-type(1) > ol:nth-of-type(1) > li:nth-of-type(35) > a:nth-of-type(1)/-/-/ ; click//////-/-/ |
| login | hybrid/groq/openai/gpt-oss-120b | 0.43 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 2029 | extra click////Login Page/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; click////Login Page/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type/username/username///#username/-/username2/; extra defaults tomsmithh |
| upload | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 0.86 | postcondition; postcondition | 0 | 1738 | extra click/file-submit////#file-submit/-/-/ ; click//////-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////File Uploader/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| dynamic-controls | hybrid/groq/openai/gpt-oss-120b | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1134 | extra click////Enable/#input-example > button:nth-of-type(1)/-/-/ |
| windows | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1300 | extra click////Opening a new window/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ ; click////Opening a new window/#content > div:nth-of-type(1) > h3:nth-of-type(1)/-/-/ |
| inputs | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | below-threshold; below-threshold | 0 | 1391 | extra key//////-/-/Backspace ; type/////#content > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > input:nth-of-type(1)/-/text2/; extra defaults 42x |
| forgot-password | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | pass | 0 | 1641 | extra click////Forgot Password/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; click////Forgot Password/#content > div:nth-of-type(1) > h2:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type/email/email///#email/-/username2/; extra defaults ada@example.comx |
| add-element | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | postcondition; postcondition | 0 | 1222 | extra click////Add Element/#content > div:nth-of-type(1) > button:nth-of-type(1)/-/-/ ; click////Delete/#elements > button:nth-of-type(1)/-/-/ |
| todo | hybrid/groq/openai/gpt-oss-120b | 0.29 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-bao-i="22"]')
    - locator resolved to <a class="" data-bao-i="22" href="#/completed">Completed</; locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('[data-bao-i="22"]')
    - locator resolved to <a class="" data-bao-i="22" href="#/completed">Completed</ | 0 | 1744 | extra click////todos/#root > header:nth-of-type(1) > h1:nth-of-type(1)/-/-/ ; key//////-/-/Backspace ; type///New Todo Input//#root > header:nth-of-type(1) > input:nth-of-type(1)/-/text2/ ; click////Completed/#root > footer:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(3) > a:nth-of-type(1)/-/-/; extra defaults buy milkx |
| checkboxes | hybrid/groq/openai/gpt-oss-120b | 0.33 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  | 1.00 | below-threshold; below-threshold | 0 | 1301 | extra check/////#checkboxes > input:nth-of-type(2)/-/-/ ; check/////#checkboxes > input:nth-of-type(2)/-/-/ |

## Bad intent texts

The judge scored 10 texts written to be bad. 0/10 came back bad (low). The rubric was not edited, and these texts were not added to the calibration set. A concrete wrong verb or a non-secret value can still score good under that rubric.

| id | judge | low | text |
| --- | --- | --- | --- |
| b1 |  |  | Click button. |
| b2 |  |  | Click the button. |
| b3 |  |  | Do the thing. |
| b4 |  |  | Type HeldOutDemoSecret! into the password field. |
| b5 |  |  | Type pin-9999 to unlock the account. |
| b6 |  |  | Type SuperSecretPassword! and log in. |
| b7 |  |  | Delete the search field. |
| b8 |  |  | Uncheck subscribe and clear the form. |
| b9 |  |  | Type Ada Lovelace into the search box. |
| b10 |  |  | Open the Help menu. |
