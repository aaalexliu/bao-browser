# Chrome agent control

## Agent entry point

Use [`agent_browser`](agent-browser-engine.md#direct-mcp-commands) through `bao mcp`. The older live tool surface and workflow replay driver are retired. No app-side session host remains.

The pass-through launches a marked private copy of the selected Chrome profile. It needs no Screen Recording, Accessibility, Automation, or daily-Chrome debugging switch. It records commands, native results, and page screenshots in Library Runs. Bao does not block final clicks.

Saved workflows with `driver: "cdp-live"` remain readable, but replay fails with `this workflow used the retired live driver` before any browser opens. Replay on the pass-through has not been built.

See [Agent quickstart](agent-quickstart.md) for setup, [pass-through behavior](agent-browser-engine.md) for commands and cleanup, and [permissions](permissions.md) for evidence privacy. Old local recordings are historical evidence, not a promise that their workflow can still run.
