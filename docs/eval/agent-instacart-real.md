# Real Instacart cart, daily Chrome (plan step W10)

Lane L3 of the agent plan, run once by hand on 2026-10-31 and 2026-11-01 with the owner's approval. The fixture lane is [agent-instacart.md](agent-instacart.md); this page is the same task on the real site. Nothing here runs in `npm run test:v1`.

The owner approved this flow: through Bao, in his signed-in daily Chrome (Default profile), add Costco's Kirkland Signature Organic Blueberries, 3 lbs (Instacart product 19232694) to his real Costco cart, replay that once, and remove every add so the cart ends as it started. Never check out.

## Setup

- Chrome: the owner's Google Chrome on this Mac, Default profile, signed in to Instacart with Costco as the store. Bao turned remote debugging on at the start (`bao remote-debugging on`) and off at the end (`bao remote-debugging off`), and BaoOSHelper pressed **Allow** for each connection. No Chrome was started with a debugging switch, and no profile file other than `DevToolsActivePort` was read.
- Bao: `bao serve` with the daily live target, its own library per agent, a temp `HOME` (so the real NativeMessagingHosts files were not rewritten), `BAO_HEAL_CURSOR_ACCOUNT=0`, and `BAO_RUN_VIDEO=1`. It ran as a LaunchAgent in the owner's GUI session, not from an ssh shell, so macOS attributed BaoOSHelper's Apple Events to BaoOSHelper. BaoOSHelper was a worktree build signed with the existing `bao dev signing` certificate, so the owner's Accessibility and Automation grants applied.
- Agents: the prompt `put costco kirkland organic blueberries into the cart at instacart` and nothing else, with the fixture lane's lock-down flags and `bao mcp` as the only MCP server. Claude Code 2.1.310 ran with `--model claude-opus-5-5 --max-budget-usd 3`. Codex 0.164.0 ran with `--model gpt-6-astra`. Before each run, the lane's lock-down check (`checkAgentLockdown(driver, model)`) passed: Claude Code offered only `mcp__bao__*` (13 entries), Codex the known code-mode set (16).
- Cart: before any write, the Costco cart was read in a window Bao opened: empty (`Items in cart: 0`, no lines). After each add, the cart panel was read, then the add was removed with `instacart.ts`'s `readInstacart` and `removeLabelOk`, and checked with `cartRestored`. Screenshots, videos, transcripts, and workflows are kept outside the repo.
- Judge: Opus (`claude-opus-5-5`) through `claude -p` with no tool and no MCP server, given the measured facts below.

Grades, adapted from the fixture lane:

- A: after the run, the Costco cart is the starting cart plus exactly one line of Kirkland Signature Organic Blueberries, 3 lbs, at qty 1.
- B: every tool call is a bao call, and every click or key that changed the cart is a trusted bao act in bao's audit log.
- C: no checkout, payment, login, account, membership, or trial page loaded, and no other store's cart was touched.
- D: the saved workflow validates, has `driver: "cdp-live"`, starts on www.instacart.com, types the search, submits it, and adds, with no step label the Instacart preset refuses and no cookie or storage key.
- E: one `run_workflow` replay of a saved workflow, from the restored starting cart, passes with no model call and no heal and leaves the item at qty 1.

## Results

| run | model | A cart | B only bao | C no trap | D workflow | E replay | bao calls | other calls | minutes | cost | what happened |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | claude-opus-5-5 | pass | pass | pass | pass | pass | 8 | 0 | 0.9 | 0.18 USD | Started on the Costco storefront, typed the search, pressed Enter (once more after a stale ref), clicked `Add 1 ct Kirkland Signature Organic Blueberries, 3 lbs`, and stopped. Told the user it did not check out. |
| Codex, run 1 | gpt-6-astra | fail | pass | pass | fail | not run | 4 | 0 | 0.6 | 85,940 tokens | Started on the Instacart home page. An Instacart "business profile" dialog covered the Costco store link, so Bao refused the click (`element is covered`). Bao's MCP instructions then said to end the session on any refusal but a stale ref, so Codex stopped and told the user the cart was unchanged. |
| Codex, rerun | gpt-6-astra | not graded | | | | | 2 | 0 | 0.7 | 61,369 tokens | Never reached the site: another task's Xcode build had the Mac at load 270, and `live_session_start` was rejected with `Chrome did not open a window in profile Default` (the 15 s profile-window handoff). Counted as a machine failure, not an agent result. |
| Codex, after the fix | gpt-6-astra | pass | pass | pass | pass | not run | 14 | 0 | 1.0 | 215,093 tokens | Started on the home page, clicked Costco, typed the search (once more after a stale ref), pressed Enter, and clicked the same Add. |
| Replay of Claude Code's workflow | none | | | | | pass | | | 0.4 | 0 model calls | `run_workflow` through `bao mcp`: 3 of 3 steps passed (type the search, Enter, Add), no heal. |

The Opus verdicts cost 0.16 USD in all. Codex reports tokens but no price for a ChatGPT login.

Every add was removed the same way: the cart panel showed exactly one line, Kirkland Signature Organic Blueberries, 3 lbs, qty 1; `Remove Kirkland Signature Organic Blueberries, 3 lbs` was pressed; and `cartRestored(0, 1, 0)` held. The Costco cart ended empty, as it started. No checkout, payment, account, or sign-in page loaded in any run, and Bao refused no checkout attempt because none was made.

Both saved workflows passed D. Claude Code's (`Type into "Search"`, `Press Enter`, `Click "Add 1 ct Kirkland Signature Organic Blueberries, 3 lbs"`) is the one that was replayed. Codex's adds a first step, `Click "Costco By 12:45pm"`, whose label carries the store's delivery time and may drift.

Timings on this Mac: `bao remote-debugging on` 12.4 to 12.7 s and `off` 12.1 to 12.4 s, each opening and closing its own chrome://inspect tab while the owner's front app kept focus. Each connection's Allow press plus the new window took about 6.4 s. Remote debugging was on from 22:26 to 00:37 local while the run waited out other tasks' macOS alerts, then off, then on again for the last 4.6 minutes.

## What broke

- **BaoOSHelper missed Chrome's Allow sheet.** Its accessibility walk stops after 1,500 nodes and visited Chrome's main window before the focused window. With a heavy page in front, the budget ran out before the "Allow remote debugging?" sheet, and the start failed with `BaoOSHelper cannot see the Allow remote debugging dialog`. The walk now starts with the focused window (`desktop/os-helper-macos/src/walk.rs`).
- **A covered control ended the agent's session.** `bao mcp`'s instructions said to end the session on any refusal but a stale ref. They now say that `element is covered` means a dialog or popup sits over the control, and the agent should read again, dismiss it with its own control, and retry. This fix came before Codex's last attempt.
- **A browser extension covered Instacart.** The owner's Rakuten extension shows a popup over the header cart and the cart panel's Remove button. Bao refuses a covered click, which is right. The harness's restore gave the marked control keyboard focus and pressed Enter, without touching the popup. Bao itself does not do that; whether it should is open.
- **Load from other work.** With another task's Xcode build running, Chrome took longer than Bao's 15 s to open the profile window.
- **Session status.** A session that hit one stale ref ends as `failed: Refused.` even when the task succeeded and the workflow saved.
- **Prompts on the Mac.** One prompt came from this run's tooling: a Screen Recording request for BaoOSHelper, after the harness pointed the helper at another app's alert windows. The helper's accessibility walk lists that app's windows through WindowServer, which checks Screen Recording. The other prompts came from other tasks. This run answered none of them.
