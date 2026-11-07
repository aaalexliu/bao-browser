# CI conflict repair and owner025 setup

## Rebase

Rebased all 16 commits from 9f030bdb1b12c1e7cdb81c05075dd08b2503b0ee onto 0071b96bf6b6d278f88ffa38e52457825f6c6cf4. Rebased HEAD: 36a4510fcfef97d0bf4865388601a163d0750494.

Resolved two content conflicts in docs/v1.md. Kept the base's Runs selection, pending-heal, and focus documentation and the branch's saved-input replay text and later replay-rules link. No product conflicts required manual changes. Reviewed range-diff.txt. All prior shared guard, registry defaults, screenshot cover, and local-default source files match the pre-rebase head. Base ancestry, no unmerged entries, rebase completion, and git diff --check pass.

## One approved install

Ran exactly once after rebase:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GROQ_API_KEY -u XAI_API_KEY -u CURSOR_API_KEY BAO_HEAL_CURSOR_ACCOUNT=0 npm ci
```

Exit 0. Before and after package-lock.json SHA-256:

```text
ed12a2add3c255272201e313ed3597b0ec600dc0715a1accb66bd012d24abc8e
```

The hashes match, and git diff --exit-code -- package.json package-lock.json passes. See npm-ci.log and lock-before.txt / lock-after.txt. No manifest, lock, module links, architecture exceptions, or baseline changes.

PR setup line for the outer executor (PR not edited in this phase):

Pipeline setup: ran one owner-approved root npm ci after rebase using the committed lockfile; the lockfile stayed unchanged.

## Narrow test correction and trace

The executable upload contract is stepId/png without redacted. The exact catalog-review-values + catalog-review pair reproduced the stale redacted=true failure before the edit (3 pass, 1 fail; review-before.log).

Changed only the received fixture type and assertion in catalog-review-values.test.ts: require Object.hasOwn(shot, "redacted") to be false. The assertion checks the actual HTTP payload, not implementation text. The independent oracle is the current wire contract; an upload that reintroduces the metadata field fails it, even if the field is false or null.

Traced reviewWorkflow -> runWorkflow -> stepShots -> fitPictureBody -> remoteFetch -> fixture receiver. Successful runs upload eligible crops; failed runs return before upload. Private token/card/SSN crops remain withheld, ordinary crop remains present, and publicSamples is unchanged. No product functions, callers, helpers, branches, or parameters changed or became unreachable. All existing PNG, local raw evidence, input types/defaults, model-call, and view/picture assertions remain intact.

## Verification

Removed desktop/dist before both builds. npm run build:desktop passed before reproduction and after the correction. npm run check:static passed completely: baseline checks, all three typechecks, ESLint, and both architecture passes. See build-before.log, build-after.log, static.log.

Every desktop invocation used node --test --test-isolation=process --test-concurrency=1 with exactly two compiled files. Final checks pinned PLAYWRIGHT_BROWSERS_PATH to the actual cache before temporary HOME, including nested children, and BAO_TEST_BROWSER to the real Playwright executable. Vendor keys, DATABASE_URL, and blob credentials were removed; BAO_HEAL_CURSOR_ACCOUNT=0. HOME/Library, Bao home, profile/native config, PGlite, and blob paths were throwaway paths. NODE_PATH points to web/node_modules. No full suite, installed app/helper, daily profile, permissions, or model calls were used.

| Exact desktop pair | Passed | Failed |
| --- | ---: | ---: |
| catalog-review-values + catalog-review | 3 | 1 |
| versions + sync-refuse | 23 | 0 |
| outbound-disclosure + sync-guard | 18 | 0 |
| saved-secret-regressions + saved-secrets-writers | 11 | 0 |
| teach-workflows + teach | 13 | 0 |
| run-view + saved-secrets-capture | 18 | 0 |

Total: 86 pass, 1 fail, no skips. Separate node --test test/essential-manifest.test.mjs: 2 pass, 0 fail.

## Remaining blocker, no waiver

024-fixed-review.log shows that the corrected absent-redacted assertion passes, but the next untouched PNG signature assertion fails at compiled line 97: expected 89 50 4e 47 0d 0a 1a 0a; received ff d8 ff db 00 43 00 0a (JPEG). The existing fitPictureBody transport path converts the uploaded crop to JPEG. This was hidden by the earlier failing assertion.

This round explicitly requires preserving the PNG byte assertion and forbids other product changes. Neither was changed, weakened, skipped, or waived. The required pair remains red and needs an owner decision for this distinct compatibility issue. Assertions later in that test do not execute after the failure; they remain unchanged, not claimed as passing.

019/021 remains the mandatory operator follow-up after pipeline outcome under 023. No push, PR edit, or pipeline-control command ran.
