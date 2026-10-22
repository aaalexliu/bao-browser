# Driver eval

Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor run only when that CLI is already logged in. This command does not start a login. Model calls are replay heal calls. Tokens are the driver CLI usage.

Replay video of one derived workflow per driver:
- claude: docs/eval/driver-replay-claude.webm
- codex: docs/eval/driver-replay-codex.webm
- cursor: docs/eval/driver-replay-cursor.webm
- scripted: docs/eval/driver-replay.webm

| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | form-file | pass | yes | yes | yes | 2/2 | 0 | 64 | 770 |  |
| claude | tabs | pass | yes | yes | yes | 2/2 | 0 | 61 | 867 |  |
| claude | login | pass | yes | yes | yes | 2/2 | 0 | 44 | 939 |  |
| claude | confirm | pass | yes | yes | yes | 2/2 | 0 | 58 | 786 |  |
| claude | drift | pass | yes | yes | yes | 2/2 | 0 | 68 | 810 |  |
| claude | dialog | pass | yes | yes | yes | 2/2 | 0 | 56 | 1062 |  |
| claude | scroll | pass | yes | yes | yes | 2/2 | 0 | 62 | 1410 |  |
| claude | choice | pass | yes | yes | yes | 2/2 | 0 | 68 | 651 |  |
| codex | form-file | pass | yes | yes | yes | 2/2 | 0 | 62 | 130761 |  |
| codex | tabs | pass | yes | yes | yes | 2/2 | 0 | 61 | 174851 |  |
| codex | login | pass | yes | yes | yes | 2/2 | 0 | 41 | 139798 |  |
| codex | confirm | pass | yes | yes | yes | 2/2 | 0 | 56 | 122314 |  |
| codex | drift | pass | yes | yes | yes | 2/2 | 0 | 67 | 85730 |  |
| codex | dialog | pass | yes | yes | yes | 2/2 | 0 | 62 | 156376 |  |
| codex | scroll | pass | yes | yes | yes | 2/2 | 0 | 68 | 157308 |  |
| codex | choice | pass | yes | yes | yes | 2/2 | 0 | 65 | 94987 |  |
| cursor | form-file | pass | yes | yes | yes | 2/2 | 0 | 58 | 29707 |  |
| cursor | tabs | pass | yes | yes | yes | 2/2 | 0 | 58 | 32015 |  |
| cursor | login | pass | yes | yes | yes | 2/2 | 0 | 43 | 17163 |  |
| cursor | confirm | pass | yes | yes | yes | 2/2 | 0 | 51 | 36013 |  |
| cursor | drift | pass | yes | yes | yes | 2/2 | 0 | 62 | 21903 |  |
| cursor | dialog | pass | yes | yes | yes | 2/2 | 0 | 58 | 17028 |  |
| cursor | scroll | pass | yes | yes | yes | 2/2 | 0 | 62 | 24676 |  |
| cursor | choice | pass | yes | yes | yes | 2/2 | 0 | 63 | 16736 |  |
| scripted | form-file | pass | yes | yes | yes | 2/2 | 0 | 58 | n/a |  |
| scripted | tabs | pass | yes | yes | yes | 2/2 | 0 | 55 | n/a |  |
| scripted | login | pass | yes | yes | yes | 2/2 | 0 | 36 | n/a |  |
| scripted | confirm | pass | yes | yes | yes | 2/2 | 0 | 50 | n/a |  |
| scripted | drift | pass | yes | yes | yes | 2/2 | 0 | 64 | n/a |  |
| scripted | dialog | pass | yes | yes | yes | 2/2 | 0 | 58 | n/a |  |
| scripted | scroll | pass | yes | yes | yes | 2/2 | 0 | 55 | n/a |  |
| scripted | choice | pass | yes | yes | yes | 2/2 | 0 | 56 | n/a |  |
