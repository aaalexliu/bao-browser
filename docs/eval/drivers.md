# Driver eval

Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor run only when that CLI is already logged in. This command does not start a login. Model calls are replay heal calls. Tokens are the driver CLI usage.

Replay video of one derived workflow per driver:
- claude: docs/eval/driver-replay-claude.webm
- codex: docs/eval/driver-replay-codex.webm
- cursor: docs/eval/driver-replay-cursor.webm
- scripted: docs/eval/driver-replay.webm

| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | form-file | pass | yes | yes | yes | 2/2 | 0 | 59 | 853 |  |
| claude | tabs | fail | yes | yes | yes | below-threshold; below-threshold | 0 | 59 | 1079 | below-threshold; below-threshold |
| claude | login | pass | yes | yes | yes | 2/2 | 0 | 46 | 1212 |  |
| claude | confirm | pass | yes | yes | yes | 2/2 | 0 | 55 | 1191 |  |
| claude | drift | pass | yes | yes | yes | 2/2 | 0 | 71 | 1178 |  |
| claude | dialog | pass | yes | yes | yes | 2/2 | 0 | 59 | 1357 |  |
| claude | scroll | pass | yes | yes | yes | 2/2 | 0 | 68 | 1018 |  |
| claude | choice | fail | yes | yes | yes | postcondition; postcondition | 0 | 64 | 609 | postcondition; postcondition |
| codex | form-file | pass | yes | yes | yes | 2/2 | 0 | 64 | 86471 |  |
| codex | tabs | fail | yes | yes | yes | below-threshold; below-threshold | 0 | 62 | 177964 | below-threshold; below-threshold |
| codex | login | pass | yes | yes | yes | 2/2 | 0 | 47 | 139345 |  |
| codex | confirm | driver-error | no | partial | no | skipped |  |  | n/a | HTTP 429 |
| codex | drift | pass | yes | yes | yes | 2/2 | 0 | 74 | 121534 |  |
| codex | dialog | pass | yes | yes | yes | 2/2 | 0 | 64 | 121423 |  |
| codex | scroll | pass | yes | yes | yes | 2/2 | 0 | 64 | 156837 |  |
| codex | choice | driver-error | no | partial | no | skipped |  |  | n/a | HTTP 429 |
| cursor | form-file | pass | yes | yes | yes | 2/2 | 0 | 60 | 17612 |  |
| cursor | tabs | fail | yes | yes | yes | below-threshold; below-threshold | 0 | 57 | 20638 | below-threshold; below-threshold |
| cursor | login | pass | yes | yes | yes | 2/2 | 0 | 41 | 32488 |  |
| cursor | confirm | pass | yes | yes | yes | 2/2 | 0 | 52 | 17216 |  |
| cursor | drift | pass | yes | yes | yes | 2/2 | 0 | 61 | 17718 |  |
| cursor | dialog | pass | yes | yes | yes | 2/2 | 0 | 58 | 18340 |  |
| cursor | scroll | pass | yes | yes | yes | 2/2 | 0 | 61 | 24805 |  |
| cursor | choice | fail | yes | yes | yes | postcondition; postcondition | 0 | 62 | 16781 | postcondition; postcondition |
| scripted | form-file | pass | yes | yes | yes | 2/2 | 0 | 61 | n/a |  |
| scripted | tabs | fail | yes | yes | yes | below-threshold; below-threshold | 0 | 56 | n/a | below-threshold; below-threshold |
| scripted | login | pass | yes | yes | yes | 2/2 | 0 | 36 | n/a |  |
| scripted | confirm | pass | yes | yes | yes | 2/2 | 0 | 50 | n/a |  |
| scripted | drift | pass | yes | yes | yes | 2/2 | 0 | 61 | n/a |  |
| scripted | dialog | pass | yes | yes | yes | 2/2 | 0 | 58 | n/a |  |
| scripted | scroll | pass | yes | yes | yes | 2/2 | 0 | 53 | n/a |  |
| scripted | choice | fail | yes | yes | yes | postcondition; postcondition | 0 | 60 | n/a | postcondition; postcondition |
