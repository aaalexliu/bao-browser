# Playwright close-latch model

## Property and bounds

`OneShutdownCompletion` says that all close and disconnect calls share at most one shutdown job and one completion promise. It covers `bindPlaywrightOwned` in `desktop/src/launch.ts`, used by `launchAccountChrome` and `launchNormalChrome` after successful attachment. Source-sync commit: `528f03cc6cea4f10c1dde3f44eab2e212590b325`.

TLC exhausts a finite model of three calls to one bound context: `disconnect`, `close`, and `closeAgain`. Each calls the same closure once, in any order, before, during, or after shutdown. Three calls cover disconnect, an explicit close, and a repeated close without increasing the state space for more followers. This is a bounded model check, not a proof for an unbounded number of calls.

Each caller's name also identifies the promise and job it creates if it wins the guard. The model records returned promise identities for disconnect too, although that handler discards the result in the real code.

## Source mapping

The model uses JavaScript's run-to-completion rule. A synchronous close call cannot interleave with another event handler. `context.pages()` and `page.isClosed()` must not throw or reenter close during that prefix. There is no `await` between the guard, scheduling the microtask, and storing `closing`.

| Model element | Source element | Atomic boundary |
| --- | --- | --- |
| `Init` | `let state: PlaywrightOwned = { phase: "running" }` | Binding completes before either entry point runs. |
| `Request(c)` | The guard in `close`, creation of `completion`, assignment of `closing`, and return | One synchronous call. `Promise.resolve().then(...)` queues work but does not run it before the assignment. A follower returns the stored promise. |
| `Start(c)` | The queued async callback, PID bookkeeping, and call to `requestBrowserClose` | The microtask runs through the first await. |
| `BrowserCloseReturns(c)` | Return from `await requestBrowserClose(browser)` and call to `releaseProfileProcesses` | One continuation through the next await. A true or false result follows the same latch path. |
| `ReleaseReturns(c)` | Return from `await releaseProfileProcesses(...)` and call to `browser.close().catch(...)` | One continuation through the next await. |
| `Settle(c)` | Completion of browser close and logging, or an earlier rejection, followed by `finally` | The closure stores `settled` with its own original completion. Rejection after bookkeeping or release can skip later work. |
| `Done` | No remaining modeled caller or shutdown work | A terminal stutter prevents a completed execution from counting as deadlock. |

`phase` maps to `state.phase`. `completion` maps to `state.completion` using a symbolic identity instead of a JavaScript promise. `returned` and `jobs` record observations, not extra product state. `TypeOK` checks the model's data shapes, not a separate product promise.

No fairness assumption is needed for this safety check. Calls can arrive in any order, but a queued callback cannot run in the middle of a synchronous call. The model does not claim shutdown eventually finishes.

## Broken variant

`Broken.cfg` sets `ReuseCompletion = FALSE`. This models weakening the early-return guard to `state.phase === "settled"` while keeping the same microtask scheduling. The shortest counterexample needs only two requests:

1. One caller enters close, queues a shutdown job, stores its completion, and returns it.
2. A second caller ignores the existing closing state, queues another job, and returns a different completion.

`OneShutdownCompletion` then fails before either job needs to run. TLC's caller order can differ because the three request names have identical guard behavior.

The [verification skill](./SKILL.md) also weakens the guard in scratch product source and runs the existing headless Chromium regression test. That test drives a real Playwright disconnect followed by repeated `context.close()` calls, checks promise identity and one shutdown, and checks that no profile processes remain. The static model alone would not notice a source edit.

## Limits

- The model covers only the shared latch after binding. It leaves out launch failures, retained windows, the endpoint latch, video launches, and the remote-run hold.
- The model treats process cleanup and browser calls as operations that may return or reject. It does not prove which PIDs they signal, whether profiles persist, or whether a browser actually exits.
- The model leaves out exceptions and synchronous reentry from `context.pages()` and `page.isClosed()`. Those calls happen before the latch assignment in current code.
- The Chromium regression test exercises `launchNormalChrome`, not the headed `launchAccountChrome` path. Source review establishes that both call the same binding function.
- The regression test covers one runtime order. The TLA+ model covers all orders only within its three-call abstraction. Neither establishes that every future source change still matches that abstraction.

TLC is the right tool here because event order, not input data, decides whether the latch works. A TypeScript typecheck cannot establish that two callbacks return the same promise. Keep the existing runtime test alongside the model rather than treating the model as a browser test replacement.
