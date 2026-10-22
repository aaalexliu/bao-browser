# Intent eval

Model access: groq / openai/gpt-oss-120b; ping tokens 112.

The condenser `condense` is deterministic and calls no model. The other condenser is the configured model. Step precision and recall compare workflow steps with the ground-truth steps. A Help click is left in the trail on purpose, so deterministic precision is below 1. Param recall is typed values, file inputs, and secret inputs. Secret is 0 if a secret literal survived in the workflow. Human precision and recall are login and confirm tags on the workflow. Model human and model secret are the ids the model returned, before interpret tags fields itself. Replay is two runs with new inputs. Model calls are heal calls during those replays.

| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | replay | model calls | tokens | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| save-name | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| email-note | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| login | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| confirm-delete | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| upload-title | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| terms | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| tabs | condense | 0.80 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| search | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| scroll-row | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| dialog | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| pay | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| pin | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| color | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| profile | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| drop-file | condense | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| signup | condense | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |  |  | pass | 0 |  |  |
| save-name | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1430 |  |
| email-note | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | email-note; email-note | 0 | 2299 |  |
| login | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1750 |  |
| confirm-delete | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 1.00 | 0.00 | 0.00 | 0.00 | 1.00 | confirm-delete; confirm-delete | 0 | 1422 |  |
| upload-title | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1299 |  |
| terms | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1224 |  |
| tabs | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1728 |  |
| search | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1161 |  |
| scroll-row | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1274 |  |
| dialog | groq/openai/gpt-oss-120b | 0.75 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1798 |  |
| pay | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 0.00 | 1.00 | pass | 0 | 1618 |  |
| pin | groq/openai/gpt-oss-120b | 1.00 | 0.33 | 0.00 | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | pin; pin | 0 | 1908 |  |
| color | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 1555 |  |
| profile | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | profile; profile | 0 | 1327 |  |
| drop-file | groq/openai/gpt-oss-120b | 0.00 | 0.00 | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | drop-file; drop-file | 0 | 943 |  |
| signup | groq/openai/gpt-oss-120b | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | pass | 0 | 2218 |  |
