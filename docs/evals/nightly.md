# Nightly eval

One command:

```
npm run eval:nightly
```

That compiles, then runs `bao eval nightly`. The run covers the fixture drift suite, frozen intent batches 2–5, and the scripted driver fixtures. Frozen batches use deterministic condense and replay. The command does not call a model.

Each run writes `results.json` and one `trajectories/<caseId>.json` per case under `docs/evals/nightly/runs/<stamp>`. The diff target is `docs/evals/nightly/baseline`. A line names the case and the step that stopped passing:

```
regression heldout/batch5/node-synopsis step node-synopsis-0: expected pass, got fail (no-candidates)
```

`npm run eval:nightly -- --save-baseline` copies the run onto that baseline.

This repository has no CI configuration, so there is no scheduled job. The command above is the nightly run.

After the Label column in [judge-labels.md](judge-labels.md) is filled with `good` or `bad`:

```
npm run eval:judge-agree
```
