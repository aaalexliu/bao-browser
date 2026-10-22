# Driver eval

Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor are marked not run when the CLI or a credential is missing. Those cells are not filled in.

Replay video of the drifted-layout workflow: docs/eval/driver-replay.webm.

| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | form-file | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | tabs | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | login | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | confirm | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | drift | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | dialog | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | scroll | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| claude | choice | not run |  |  |  |  |  |  |  | not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed |
| codex | form-file | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | tabs | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | login | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | confirm | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | drift | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | dialog | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | scroll | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| codex | choice | not run |  |  |  |  |  |  |  | not run: codex CLI is not on PATH and OPENAI_API_KEY is unset |
| cursor | form-file | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | tabs | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | login | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | confirm | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | drift | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | dialog | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | scroll | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| cursor | choice | not run |  |  |  |  |  |  |  | not run: cursor-agent CLI is not on PATH |
| scripted | form-file | pass | yes | yes | yes | 2/2 | 0 | 70 | n/a |  |
| scripted | tabs | pass | yes | yes | yes | 2/2 | 0 | 69 | n/a |  |
| scripted | login | pass | yes | yes | yes | 2/2 | 0 | 60 | n/a |  |
| scripted | confirm | pass | yes | yes | yes | 2/2 | 0 | 65 | n/a |  |
| scripted | drift | pass | yes | yes | yes | 2/2 | 0 | 78 | n/a |  |
| scripted | dialog | pass | yes | yes | yes | 2/2 | 0 | 75 | n/a |  |
| scripted | scroll | pass | yes | yes | yes | 2/2 | 0 | 73 | n/a |  |
| scripted | choice | pass | yes | yes | yes | 2/2 | 0 | 78 | n/a |  |
