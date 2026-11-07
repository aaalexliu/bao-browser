# Contributing to Bao

## Source boundaries

`desktop/` owns Bao.app and the local service. `extension/` owns the
native-messaging extension Bao.app bundles. `web/` owns the optional registry.
`shared/` holds code those products can import, including desktop masking and
workflow types moved out of the retired root extension.

The root extension is no longer a build target. Do not restore `src/`, the root
manifest, `build.mjs`, `npm run watch`, `install-dev-legacy.sh`, or the serial
`test/all.mjs` suite. Use `npm run build:extension` and `install-extension.sh`
for the desktop extension. `scripts/stage-unpacked.mjs` still serves that
installer; its safety tests stay in `desktop/test/unit/install-scripts.test.ts`.

## Local checks

Install the lockfile dependencies with `npm ci` and `npm --prefix web ci`.
Use the Node version in `.nvmrc`. Run `npm run check:static` and the focused
tests for your change. [Testing](docs/TESTING.md) describes safe browser and
Library isolation. Do not run full local suites on the shared Mac when focused
checks will do.

For a packaging change, build desktop and extension, then build Bao.app using
[Mac build](docs/mac-build.md). Reuse the signed helper; do not rebuild it or
change permissions to make a test pass. Verify the extension inside the built
app, not just the checkout bundle.

## No-mistakes dependency setup

On this Mac, Review and its fix rounds get dependencies from a home-local Bao
gate post-checkout hook. No-mistakes prepares only before Test, Lint, and Format,
not before Review. A new gate, a re-init, or another machine needs that hook
reinstalled. Keep the hook script outside the Bao repository. The upstream fix
is a no-mistakes feature to run preparation before Review.

The hook fills the root and web `node_modules` in each new run copy before Review.

## PR checks

Every PR gets the essential tests and static gates. Decide whether the
`full-suite` label is needed and state the choice and reason in the PR body.
Choose it for shared runtime, packaging, or test-infrastructure changes that
the essential set does not fully cover. A removal must name each deleted test,
its last measured time (or note that no measurement exists), and the retired
behavior it guarded. Never treat a deleted test as coverage for a kept feature.

[Guardrails](docs/guardrails.md) explains the lint and import budgets. Prune
baselines with the built-in commands; do not hand-edit generated files or grow
a budget to hide new findings.
