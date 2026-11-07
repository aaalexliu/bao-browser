# Chrome agent control

## Agent entry point

Use [`agent_browser`](agent-browser-engine.md#direct-mcp-commands) through `bao mcp`. The older live tool surface and workflow replay driver are retired. No app-side session host remains.

By default, the pass-through launches a marked private copy of the selected Chrome profile, with no Mac privacy grant or daily-Chrome debugging switch. Explicit [`browser: "current"`](agent-browser-engine.md#use-the-owners-running-chrome) instead drives the owner's running Chrome and actual profile. BaoOSHelper uses its existing Accessibility grant to enable debugging and press Allow. It does not use Automation or Screen Recording. Both routes record commands, native results, and page screenshots in Library Runs. Bao does not block final clicks.

Saved workflows with `driver: "cdp-live"` remain readable, but replay fails with `this workflow used the retired live driver` before any browser opens. Supported pass-through tasks save workflows that replay through the current browser engine; unsupported tasks stay capture-only with a reason.

See [Agent quickstart](agent-quickstart.md) for setup, [pass-through behavior](agent-browser-engine.md) for commands and cleanup, and [permissions](permissions.md) for evidence privacy. Old local recordings are historical evidence, not a promise that their workflow can still run.
