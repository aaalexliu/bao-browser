# Bao

Bao lets an agent drive Chrome through the `agent_browser` pass-through MCP tool.
See [Direct MCP commands](docs/agent-browser-engine.md#direct-mcp-commands) for commands and limits.

The older live tools and their replay driver are retired. Saved `cdp-live` workflows stay readable but cannot replay until replay is rebuilt on the pass-through. Bao does not block final clicks.

## Agent quickstart

This checkout has three products:

1. **Desktop app and service:** `desktop/`, packaged as Bao.app.
2. **Native-messaging extension:** `extension/`, bundled in Bao.app and staged by `install-extension.sh`.
3. **Optional registry:** `web/`, a Next.js app for sync and sharing.

The old standalone root extension is retired. Its root manifest, side panel,
dashboard, build/watch/package commands, installer, and tests are gone. Do not
load the repository root as an unpacked extension. The desktop extension stays.
Shared desktop masking and workflow types now live in `shared/mask.ts` and
`shared/types.ts`.

Run commands from the repo root. Node is the major version in `.nvmrc` and
`mise.toml`. `nvm use` can print that version while an older `node` stays first
on PATH. Prepend the bin directory from `nvm which node`:

```sh
export PATH="$(dirname "$(nvm which node)"):$PATH"
node scripts/check-node.mjs
npm ci
npm --prefix web ci
npx playwright install chromium
```

`node scripts/check-node.mjs` exits 1 when Node is older than `.nvmrc`.

| Task | Command or guide |
| --- | --- |
| Build desktop | `npm run build:desktop` |
| Build desktop extension | `npm run build:extension` |
| Stage desktop extension | `./install-extension.sh`, then load the printed directory at `chrome://extensions` |
| Run desktop | `npm run bao` after building; see the isolation warning below |
| Run registry | `npm --prefix web run dev` |
| Check types | `npm run typecheck` checks desktop/shared, extension, and web |
| Check static gates | `npm run check:static`; see [guardrails](docs/guardrails.md) |
| Run desktop tests | `npm run test:desktop:unit` (`npm run test:v1` is an alias) |
| Run web tests | `npm --prefix web test` |
| Run aggregate | `npm run check` checks types and runs desktop units |
| Run local browser integration | `npm run test:desktop:integration` |
| Build Mac app | `npm run package:mac`; see [Mac build](docs/mac-build.md) |
| Check Mac app | Follow [Mac acceptance](docs/mac-test.md) |

`./install-dev.sh` only points to `./install-extension.sh` and exits 2.
`npm run bao` runs the compiled CLI; it does not compile.

A checkout `bao serve` writes a Chrome native-messaging manifest under `HOME`.
`BAO_HOME` alone does not isolate that write. Tests must use a temp `HOME`, Bao
home, and browser profile, with model keys unset and `BAO_HEAL_CURSOR_ACCOUNT=0`.
Do not use a daily Chrome profile or the installed Library for tests.

## MCP

For Claude Desktop and ChatGPT, see [Add Bao to a desktop app](docs/desktop-mcp-install.md).

CLI agents run `/Applications/Bao.app/Contents/MacOS/bao-mcp`. After building the
desktop, `node desktop/dist/desktop/src/app/cli.js agent config claude --write`
(or `codex`) adds that entry and pre-approves Bao's tools in that CLI agent.
[Agent quickstart](docs/agent-quickstart.md#mcp) has the entries and checkout form.
[Agent-browser pass-through](docs/agent-browser-engine.md) explains profile selection, copy limits, owner handoff, and evidence.
[Read-only MCP viewer](docs/mcp-viewer.md) covers annotated browser cards,
run history, and receipts in MCP Apps hosts.

## Development guides

- [Contributing](CONTRIBUTING.md) covers source ownership and local checks.
- [Testing](docs/TESTING.md) covers focused checks and the opt-in full suite.
- [Desktop extension](docs/extension.md) covers install and driver selection.
- [Permissions](docs/permissions.md) covers helper grants.

Older root-extension design notes remain as historical records, not current
installation or acceptance instructions.

## Host the sync registry on Vercel

The registry lives in `web/`; its project settings are in
[`web/vercel.json`](web/vercel.json). This repo does not create the Vercel
project, database, or blob store.

1. Open [vercel.com/new](https://vercel.com/new) and import this git repository.
2. Choose Next.js and set Root Directory to `web`.
3. Generate an invite secret with `openssl rand -hex 32`. Do not commit it. Set `BAO_OWNER_EMAIL` to the one email that may sign in and `BAO_INVITE_SECRET` to that secret (Sensitive). Do not set `BAO_AUTH_STUB`; production refuses to start with it.
4. Deploy with Standard Protection on. Copy the production domain, not a preview or generated deployment URL. All Deployments would block the Mac, which sends only its device token.
5. In Storage, create a Private Blob store and connect it to the project. This sets `BLOB_STORE_ID` for redacted PNGs. Do not create a public store.
6. In Marketplace, choose Neon and the free plan. Read and accept the plan. Neon injects `DATABASE_URL`. Do not install the sunset Vercel Postgres or KV products.
7. Redeploy so functions see `DATABASE_URL`, `BLOB_STORE_ID`, and the owner variables.
8. Sign in with the owner email and invite secret. In Settings → Sync, paste the production domain, Devices pairing code, and invite secret once. Pair, then Sync.

Variable names, with empty values, are in [`web/.env.example`](web/.env.example).
[web/README.md](web/README.md) has the click-through guide.

Locally, from `web/`, `npx vercel dev --local` leaves `DATABASE_URL` and
`BLOB_STORE_ID` unset. The app uses PGlite under `BAO_PG_DIR` (or
`web/.data/pglite`) and files under `BAO_BLOB_DIR` (or `web/.data/blobs`). Pair,
push, and pull against that server as with a hosted registry.
