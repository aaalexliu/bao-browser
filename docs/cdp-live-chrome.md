# Chrome agent control

## Agent entry point

Use [`agent_browser`](agent-browser-engine.md#direct-mcp-commands) through `bao mcp`. The older live tool surface and workflow replay driver are retired. No app-side session host remains.

By default, the pass-through launches a marked private copy of the selected Chrome profile, with no Mac privacy grant or daily-Chrome debugging switch. Explicit [`browser: "current"`](agent-browser-engine.md#use-the-owners-running-chrome) instead drives the owner's running Chrome and actual profile. Bao drives it through the [Bao extension](extension.md#running-chrome), with no Mac privacy grant and no debugging port. Both routes record commands, native results, and page screenshots in Library Runs. Bao does not block final clicks.

A saved file that is not [schema v4](workflow-schema.md) is not loaded. Supported pass-through tasks save workflows that replay through the current browser engine; unsupported tasks stay capture-only with a reason.

See [Agent quickstart](agent-quickstart.md) for setup, [pass-through behavior](agent-browser-engine.md) for commands and cleanup, and [permissions](permissions.md) for evidence privacy. Old local recordings are historical evidence, not a promise that their workflow can still run.
