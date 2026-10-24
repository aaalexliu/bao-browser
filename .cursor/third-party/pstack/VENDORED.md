# Vendored pstack

pstack is Lauren Tan's public Cursor skill pack, published in the
[cursor/plugins](https://github.com/cursor/plugins) monorepo under `pstack/`.

| | |
| --- | --- |
| Upstream | https://github.com/cursor/plugins/tree/75fabace38ce507ee044546eaca64167c8c1e21b/pstack |
| Commit | `75fabace38ce507ee044546eaca64167c8c1e21b` (2026-10-18, "pstack: drop the rewritten-prompt ban from sharpen (#712)") |
| Plugin | `pstack` 0.15.26 |
| Author | Lauren Tan |
| License | MIT, copied verbatim to `LICENSE` in this directory |
| Homepage | https://github.com/cursor/plugins/tree/main/pstack |

Skill text is copied unchanged. Nothing in `.cursor/skills/` or
`.cursor/agents/poteto-agent.md` was rewritten for this repo.

## What was copied

From `pstack/skills/`, each directory in full (skill file plus every
`references/`, `playbooks/`, and `scripts/` file that skill ships):

- `architect`
- `arena`
- `how`
- `interrogate`
- `principle-exhaust-the-design-space`
- `principle-foundational-thinking`
- `principle-model-the-domain`
- `principle-prove-it-works`
- `poteto-mode`
- `technical-writing`
- `unslop`

From `pstack/agents/`:

- `poteto-agent.md` → `.cursor/agents/poteto-agent.md`

`poteto-mode` tells a delegate to read that agent file, and the agent file
tells the delegate to read `skills/poteto-mode/SKILL.md`. In this repo those
paths are `.cursor/agents/poteto-agent.md` and
`.cursor/skills/poteto-mode/SKILL.md`.

## What was not copied

The rest of the plugin. `poteto-mode` names sibling skills this vendor does
not include. Applying one of those principles means reading the leaf from
upstream, not from this tree. Missing leaves include `swarm`, `why`,
`reflect`, `no-comments`, `benchmark-checklist`, `show-me-your-work`,
`figure-it-out`, `setup-pstack`, and the `principle-*` skills other than the
four listed above (`principle-laziness-protocol`,
`principle-sequence-verifiable-units`, and the rest of the Principles index).
