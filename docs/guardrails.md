# Stop new drift

The `Guardrails / guardrails` GitHub check runs on pull requests and pushes to
`main`, on Linux with Node from `.nvmrc`. Make this check required in the branch
rules. A workflow alone cannot turn on branch protection.

Run the checks locally with the commands below. The
[PR workflow](../.github/workflows/guardrails-pr.yml) owns the blocking invocation.
The [full workflow](../.github/workflows/guardrails.yml) runs only with the
`full-suite` PR label or manual dispatch. It has no nightly schedule and is not a
required check. [Testing guidance](TESTING.md#choose-the-pr-checks) explains when
to opt in. Always state that choice and its reason in the PR body.

```sh
npm ci
npm --prefix web ci
npm run check:static
npm run test:guardrails
node --test test/essential-manifest.test.mjs
npx playwright install chromium
npm run build:desktop
# Run one group from test/essential.json, with an isolated HOME:
HOME="$(mktemp -d)" BAO_HEAL_CURSOR_ACCOUNT=0 node scripts/test-essential.mjs <group>
# Opt in to the full remote check when the change needs it:
gh-axi pr edit <number> --add-label full-suite
```

`check:static` runs the baseline budget check, all four TypeScript checks, typed
ESLint, and the import gate. It never starts Bao or a browser. Enable the same
fast checks before each push with `npm run hooks:enable`. Hooks are bypassable;
CI is the gate. Both packages must be installed for the static checks.

The PR check keeps typecheck, typed lint, architecture, baseline budgets, and
all guardrail self-tests. Independent static gates and essential groups run in
parallel. The `guardrails` job fails unless every gate and group passes, so the
required check name stays unchanged.

[`test/essential.json`](../test/essential.json) is the only essential-test set.
It gives each group a reason, lists its test files, and names selected tests when
a large mixed file contains both safety cases and slower feature cases. A
manifest self-test rejects missing files, stale test names, and overlapping
selections. The full workflow always runs the full source inventory; tests not
in the essential set are not deleted or disabled locally.

Both workflows cache npm downloads and the lockfile-pinned Playwright Chromium.
Ubuntu 24.04 already has Chromium's system libraries, so neither job installs
browser dependencies with apt. Only the video privacy group needs FFmpeg in the
PR check, and installs it only when the runner lacks it.

CI gives the test commands a throwaway `HOME` and no vendor API keys. It keeps
Playwright's browser cache outside that home. The desktop runner also strips
inherited `BAO*` settings and disables account healing. Public-site tests,
billable evals, native helper builds, signing, and macOS permission checks do
not belong in this job.

## Typed lint

`eslint.config.mjs` enables the report's 20 correctness rules on TypeScript in
`desktop/src`, `desktop/test`, `extension/src`, legacy `src`, `web/src`, and
`shared`. It uses the four existing tsconfigs. The desktop project includes
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
the legacy extension, and web. No product may add imports of another product's
implementation, including type-only imports. Main's browser-safe helpers in
`shared/` sit outside those four products. Products may import them. Shared
helpers may reuse product contracts through type-only imports, but must not
import product runtime code. Both graph passes include shared files, including
those no product imports yet. This guardrail change does not move product code.

The gate also blocks replay/domain imports of app views and view types, and
shipped desktop imports of eval/proof modules. The current mixed `v1/` directory
is not treated as a pure domain layer. A full services/adapters split remains
future work.

`.dependency-cruiser-known-violations.json` owns the explicit existing
rule/source/target exceptions. The product rules cover all directions,
including desktop's imports of legacy types/masking helpers and the extension's
host grant helper. Both `views.ts` and `view-types.ts` are protected.

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

## Known existing failure

Untouched `origin/main` at `1c2852f9d01fe1f5201409958bb14e8d2592e97c`
fails **teach the fixture, correct three cards, replay twice, and splice a fix**
in `desktop/test/unit/teach-app.test.ts`. A quiet, serial Node 24.18.0 run with
one test, a throwaway `HOME`, no model keys, and pinned Playwright Chromium
reproduced the same `/mark/` assertion as the task branch. The review UI shows
`Bao stopped. Open Chrome to check the page before continuing.` for two events.
The untouched-main run exited 1 with one failure and no skipped tests.

Full local proof and raw output are
`/Users/alexliu/dev/firstmate/data/bao-lint-guardrails/main-proof.md` and
`main-proof.log` in that directory. Firstmate authorized this narrow exclusion
after main reproduced it. CI skips only that exact test name; the other tests
in `teach-app.test.ts` still run. The default `npm run test:v1` does not skip it.
Remove the CI skip when the existing failure is fixed.

`desktop/test/run-v1.mjs` forwards Node test-runner options. CI uses
`--test-concurrency=2` to bound browser load and `--test-skip-pattern` for this
single exclusion. TAP reports failures at once. `--test-force-exit` ends each
test process after its tests finish, so a failed browser startup cannot leave
a fixture server open until the job times out. Failed assertions still fail
the job. A full local run's `extension-shots` timeout passed in a
quiet serial rerun and is not excluded.

## Compiler floor

All four projects enable `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, and `noImplicitReturns`. The desktop-connected extension
(`extension/tsconfig.json`) also enables `noUncheckedIndexedAccess`. The
prerequisite cleanup removes unused declarations and makes return intents explicit. It retains the
sign-in route's consent check and the side effects of discarded initializers.
Root/desktop indexed-access work, web's two indexed-access diagnostics, exact
optional properties, broad assertion cleanup, source-wide formatting, the run
store rewrite, and Rust lint remain out of this step.
