# Chrome agent control

## Agent entry point

Use [`agent_browser`](agent-browser-engine.md#direct-mcp-commands) through `bao mcp`. The older live tool surface and workflow replay driver are retired. No app-side session host remains.

By default, the pass-through drives the owner's running Chrome. See [Use the owner's running Chrome](agent-browser-engine.md#use-the-owners-running-chrome). BaoOSHelper uses its existing Accessibility grant to enable debugging and press Allow. It does not use Automation or Screen Recording. Naming `browser: "bao"` or `browser: "copy"` uses Bao's profile or a marked copy instead, except the sites that stay in running Chrome ([Sites that stay in running Chrome](agent-browser-engine.md#sites-that-stay-in-running-chrome)). Those routes need no Mac privacy grant. Running Chrome and those routes record commands, native results, and page screenshots in Library Runs. Bao does not block final clicks.

A saved file that is not [schema v4](workflow-schema.md) is not loaded. Supported pass-through tasks save workflows that replay through the current browser engine; unsupported tasks stay capture-only with a reason.

See [Agent quickstart](agent-quickstart.md) for setup, [pass-through behavior](agent-browser-engine.md) for commands and cleanup, and [permissions](permissions.md) for evidence privacy. Old local recordings are historical evidence, not a promise that their workflow can still run.
