# Bad intent texts

Model access: groq / openai/gpt-oss-120b. 

This call uses the same rubric as calibration. The example JSON uses b1 and b2, because the first held-out call followed the calibration example keys l1-l10 and left these rows blank. That first table is in `batch1.md` and is unchanged.

5/10 scored bad.

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
