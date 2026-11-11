# Stop new drift

The `Guardrails / guardrails` GitHub check runs on pull requests and pushes to
`main`, on Linux with Node from `.nvmrc`. Make this check required in the branch
rules. A workflow alone cannot turn on branch protection.

Run the checks locally with the commands below. The
[PR workflow](../.github/workflows/guardrails-pr.yml) owns the blocking invocation.
The [full workflow](../.github/workflows/guardrails.yml) runs all desktop tests
without test-name exclusions, only with the `full-suite` PR label or manual
dispatch. It has no nightly schedule and is not a required check.
[Testing guidance](TESTING.md#choose-the-pr-checks) explains when to opt in.
Always state that choice and its reason in the PR body. The full workflow runs
desktop and web tests only. The old root-extension build, 21 serial suites, and
legacy essential group are retired. The desktop native-messaging extension and
its tests remain. [Retirement evidence](ci-test-selection.md#legacy-extension-retirement)
lists the deleted suites, timings, and behavior.

```sh
npm ci
npm run check:static
npm run test:guardrails
node --test test/essential-manifest.test.mjs
npx playwright install chromium
npm run build:desktop
# Run one group from test/essential.json, with an isolated HOME:
( export HOME="$(mktemp -d)"; trap 'rm -rf "$HOME"' EXIT
  BAO_HEAL_CURSOR_ACCOUNT=0 node scripts/test-essential.mjs <group> )
# Opt in to the full remote check when the change needs it:
gh-axi pr edit <number> --add-label full-suite
```

`check:static` runs the baseline budget check, all three TypeScript checks, typed
ESLint, and the import gate. It never starts Bao or a browser. Enable the same
fast checks before each push with `npm run hooks:enable`. Hooks are bypassable;
CI is the gate. `npm ci` installs both packages, which the static checks need.

The PR check keeps typecheck, typed lint, architecture, baseline budgets, and
all guardrail self-tests. [Coverage and selection evidence](ci-test-selection.md)
records each test file's measured yield and the opt-in-only inventory.
Independent static gates and essential groups run in
parallel. The `guardrails` job fails unless every gate and group passes, so the
required check name stays unchanged.

[`test/essential.json`](../test/essential.json) is the only essential-test set.
It gives each group a reason, lists its test files, and names selected tests when
a large mixed file contains both safety cases and slower feature cases. A
manifest self-test rejects missing files, stale test names, and overlapping
selections. The full workflow always runs the full source inventory. Tests for retired
features leave both the source inventory and the manifest. The retired live
driver's tests are listed in [selection evidence](ci-test-selection.md). The
pass-through keeps sign-in and bot-wall handoffs and redirect coverage; it has
no final-click guard.

Both workflows cache npm downloads and the lockfile-pinned Playwright Chromium.
Ubuntu 24.04 already has Chromium's system libraries, so the essential groups
skip apt browser setup. The optional full check keeps main's canonical
`playwright install --with-deps chromium`, including its extra fonts, so full
suite layout tests retain their original environment. Only groups that declare
`ffmpeg` in the manifest set up video tools. The core group contains video privacy checks, which need them; other groups
never install them. Both workflows use the shared
[CI video-tools action](../.github/actions/setup-ffmpeg/action.yml), with a pinned
static FFmpeg/ffprobe release, a content-keyed cache, and SHA-256 checks on every
use. A cache miss downloads two files with a 20-second limit each instead of
installing 87 apt packages. No system encoder or apt fallback can bypass the
pinned hashes.
The test jobs also cache lockfile-pinned dependencies and compiled desktop code,
with source/configuration hashes in the build key. The key includes the PR
workflow so build flags cannot reuse a stale artifact. Essential jobs restore
`node_modules`, not a second global npm-download cache. Their build uses
`--noCheck` only to emit JavaScript. The required `static (types)` gate still runs
all three full typechecks on every commit. Local and full-suite builds retain
normal TypeScript checking. A 433-file comparison found byte-identical JavaScript
from normal and emit-only builds.

CI gives the test commands a throwaway `HOME` and no vendor API keys. It keeps
Playwright's browser cache outside that home. The desktop runner also strips
inherited `BAO*` settings and disables account healing. Public-site tests,
billable evals, native helper builds, signing, and macOS permission checks do
not belong in this job.

## Typed lint

`eslint.config.mjs` enables the report's 20 correctness rules on TypeScript in
`desktop/src`, `desktop/test`, `extension/src`, `web/src`, and `shared`.
It uses the three product tsconfigs. The desktop project includes
all shared files, even those no product imports yet. It excludes dependencies and generated
output, including Next's generated declarations. It adds no formatting or
assertion rules. JavaScript and HTML-embedded scripts are not typed-lint
coverage in this first step.

Only package-qualified `node:test` registration calls (`test`, `it`, `describe`,
`suite`) are promise exceptions. Other test promises must pass the same rules
as source. Null comparisons may use `== null` or `!= null`. Inline ESLint
configuration cannot bypass the checked-in rules. TypeScript suppression
comments are forbidden.

`eslint-suppressions.json` owns the migration budgets by file and rule.
These entries mark migration work, not proven product bugs. Background work
should catch errors or use a task helper that reports them. `void` alone does
not handle a rejection.

ESLint's built-in bulk suppressions count errors per file and rule. They do
not identify a source line. Replacing an old error with a new one in the same
file/rule can fit the old budget. New files get no budget. This is a migration
gate, not a claim that every changed line is safe.

## Import ownership

`.dependency-cruiser.cjs` separates desktop, the desktop-connected extension,
and web. No product may add imports of another product's
implementation, including type-only imports. Main's browser-safe helpers in
`shared/` sit outside those three products. Products may import them. Shared
helpers may reuse product contracts through type-only imports, but must not
import product runtime code. Both graph passes include shared files, including
those no product imports yet. The retired root extension's masking and workflow contracts now live in
`shared/mask.ts` and `shared/types.ts`, because desktop code still imports them.

The gate also blocks replay/domain imports of app views and view types, and
shipped desktop imports of eval/proof modules. The current mixed `v1/` directory
is not treated as a pure domain layer. A full services/adapters split remains
future work.

`.dependency-cruiser-known-violations.json` owns the explicit existing
rule/source/target exceptions. The product rules cover all directions,
including the extension's host grant helper. Shared masking and types no longer
need cross-product exceptions. Both `views.ts` and `view-types.ts` are protected.

Both graph passes use `web/tsconfig.json` to resolve the existing `@/*`
imports from the web product. Other products use relative imports. Reusing the
web mapping keeps alias imports in the graph instead of dropping unresolved
edges at the source-root filter. Regression tests cover a web runtime cycle
through `@/` and forbidden web imports through relative and alias paths.

`.dependency-cruiser.runtime.cjs` checks a second graph with type-only edges
removed. Runtime cycles have no baseline and must stay at zero. Type-only
cycles are not runtime initialization bugs and are not banned here. Static
imports do not cover HTTP calls, subprocess links, or dynamically built paths.

## Baselines only shrink

CI compares each lint file/rule count and each graph rule/source/target edge
to the trusted target commit. Pushes to `main` compare to the previous commit.
Local checks default to `origin/main`; run `git fetch origin main` to refresh it.
`BASELINE_REF=<commit>` selects a different reference for a local check. A
missing reference fails, rather than silently skipping the comparison.

The first addition of these baseline files has no prior budget and needs full
review. Once present on `main`, adding or increasing a suppression, moving a
budget to a new file, or adding a graph edge fails `baselines:check`, even if
the linter or cruiser would otherwise suppress it. Deleting a suppressed source
file also fails until its lint entry is removed. ESLint and dependency-cruiser
report unused suppressions and stale graph entries as failures.

After fixing old findings, prune the built-in files:

```sh
npm run lint:prune
npm run arch:prune
npm run check:static
```

Do not regenerate a larger baseline to make new code pass. Fix the new code.
The initial adoption used ESLint's `--suppress-all` and dependency-cruiser's
`--baseline`; those are not normal development commands.

`test:guardrails` runs the actual tools in throwaway repositories. It proves
that floating promises, type-only and runtime forbidden imports, runtime
cycles, increased/new suppressions, and unused entries fail. It also proves
safe `node:test` registration, type-only cycles, and budget pruning pass.

## Desktop runner

See [Desktop tests](../desktop/test/README.md) for the runner's concurrency
default and override options. CI uses TAP to report failures at once.
`--test-force-exit` ends each test process after its tests finish, so a failed
browser startup cannot leave a fixture server open until the job times out.
Failed assertions still fail the job.

## Compiler floor

All three projects enable `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, and `noImplicitReturns`. The desktop-connected extension
(`extension/tsconfig.json`) also enables `noUncheckedIndexedAccess`. The
prerequisite cleanup removes unused declarations and makes return intents explicit. It retains the
sign-in route's consent check and the side effects of discarded initializers.
Desktop indexed-access work, web's two indexed-access diagnostics, exact
optional properties, broad assertion cleanup, source-wide formatting, the run
store rewrite, and Rust lint remain out of this step.
