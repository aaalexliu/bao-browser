# Intent lint and bad texts

Model access: groq / openai/gpt-oss-120b. lint rejected every bad text before the model

The lint runs first. It rejects a generic verb-only sentence, a destructive verb the step does not do, a Help goal, and a literal that matches a secret or a param slot. The rubric is unchanged. The model scores only the texts the lint passes. The earlier 5/10 table stays in `bad-judge.md`.

10/10 bad texts caught. 0/24 good intents falsely rejected.

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

False rejects: none.
