# Driver eval

Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor run only when that CLI is already logged in. This command does not start a login. Model calls are replay heal calls. Tokens are the driver CLI usage.

Replay video of one derived workflow per driver:
- claude: docs/eval/driver-replay-claude.webm
- codex: docs/eval/driver-replay-codex.webm
- cursor: docs/eval/driver-replay-cursor.webm
- scripted: docs/eval/driver-replay.webm

| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | form-file | pass | yes | yes | yes | 2/2 | 0 | 90 | 752 |  |
| claude | tabs | pass | yes | yes | yes | 2/2 | 0 | 89 | 969 |  |
| claude | login | fail | yes | yes | yes | flash ; flash  | 0 | 80 | 2626 | flash ; flash  |
| claude | confirm | pass | yes | yes | yes | 2/2 | 0 | 80 | 883 |  |
| claude | drift | pass | yes | yes | yes | 2/2 | 0 | 102 | 679 |  |
| claude | dialog | pass | yes | yes | yes | 2/2 | 0 | 89 | 1007 |  |
| claude | scroll | pass | yes | yes | yes | 2/2 | 0 | 86 | 1089 |  |
| claude | choice | pass | yes | yes | yes | 2/2 | 0 | 96 | 536 |  |
| codex | form-file | fail | yes | no | yes | no-candidates; no-candidates | 0 | 80 | 138879 | file path stored in the trail; path in trail.jsonl; no-candidates; no-candidates |
| codex | tabs | pass | yes | yes | yes | 2/2 | 0 | 96 | 159825 |  |
| codex | login | fail | yes | yes | yes | flash ; flash  | 0 | 88 | 65308 | flash ; flash  |
| codex | confirm | fail | no | no | no | ENOENT: no such file or directory, open '[tmp]' |  |  | n/a | cli exit 1; cli exit 1; no trail; ENOENT: no such file or directory, open '[tmp]' |
| codex | drift | pass | yes | yes | yes | 2/2 | 0 | 95 | 68098 |  |
| codex | dialog | pass | yes | yes | yes | 2/2 | 0 | 86 | 140255 |  |
| codex | scroll | fail | no | no | no | ENOENT: no such file or directory, open '[tmp]' |  |  | n/a | cli exit 1; cli exit 1; no trail; ENOENT: no such file or directory, open '[tmp]' |
| codex | choice | pass | yes | yes | yes | 2/2 | 0 | 96 | 111246 |  |
| cursor | form-file | pass | yes | yes | yes | 2/2 | 0 | 81 | 34176 |  |
| cursor | tabs | pass | yes | yes | yes | 2/2 | 0 | 85 | 17762 |  |
| cursor | login | fail | yes | yes | yes | flash ; flash  | 0 | 76 | 17199 | flash ; flash  |
| cursor | confirm | pass | yes | yes | yes | 2/2 | 0 | 76 | 17460 |  |
| cursor | drift | pass | yes | yes | yes | 2/2 | 0 | 86 | 51343 |  |
| cursor | dialog | pass | yes | yes | yes | 2/2 | 0 | 84 | 19031 |  |
| cursor | scroll | pass | yes | yes | yes | 2/2 | 0 | 92 | 45958 |  |
| cursor | choice | pass | yes | yes | yes | 2/2 | 0 | 84 | 16963 |  |
| scripted | form-file | pass | yes | yes | yes | 2/2 | 0 | 80 | n/a |  |
| scripted | tabs | pass | yes | yes | yes | 2/2 | 0 | 80 | n/a |  |
| scripted | login | pass | yes | yes | yes | 2/2 | 0 | 62 | n/a |  |
| scripted | confirm | pass | yes | yes | yes | 2/2 | 0 | 72 | n/a |  |
| scripted | drift | pass | yes | yes | yes | 2/2 | 0 | 84 | n/a |  |
| scripted | dialog | pass | yes | yes | yes | 2/2 | 0 | 80 | n/a |  |
| scripted | scroll | pass | yes | yes | yes | 2/2 | 0 | 75 | n/a |  |
| scripted | choice | pass | yes | yes | yes | 2/2 | 0 | 83 | n/a |  |
