# Bao desktop redesign - shared brief

Archived design input from November 5, 2026, with personal data replaced by placeholders.
The instructions below describe the original mock exercise, not current repository work.
See [README.md](README.md) for the confirmed Runs decision and review limits.

Every design agent reads this whole file first. You own ONE direction. The other two
agents build very different directions in parallel; do not converge toward a safe middle.

## Product

Bao is a Mac app. A person records a repetitive browser task once ("log in, open the
report, download the CSV"). Bao turns it into readable steps. It replays them on demand,
deterministically, in a Chrome that Bao owns (separate profile, not the person's daily
Chrome). No LLM at replay time. When a page changed, Bao either heals the step (proposes
a new target, kept after 3 clean runs) or stops with a clear report. Bao never presses an
irreversible button (Place order, Submit payment, Reserve). It pauses on "needs you"
instead. It also pauses for log in, 2FA codes, and bot checks.

Users: non-technical prosumers first (government forms, bills, statements, groceries,
"I did this last year and forgot how"). Second: QA people who want record-to-test.

Source repo: `/Users/owner/dev/bao-mac-m1` (branch `v1/desktop`). The app UI is
`desktop/src/app/` (`views.ts`, `client.ts`, `public/index.html` holds the CSS tokens).
Brand mark: orange squircle "bun" with `^ ^` eyes and three steam wisps. See
`/Users/owner/dev/bao-mac-m1/mockups/icons/icon-final.html` and reuse that inline SVG.

## Objects

- **Workflow**: name, one-line intent, start site, steps, inputs, heal policy
  (auto / ask / never), last run status, a golden screenshot per step.
- **Step**: plain-English label ("Click Get started", "Type the app name"), action kind
  (click, type, select, upload, download, wait for you, extract table, check), target
  element, golden screenshot, optional input binding, optional check ("expect URL
  contains /storefront").
- **Input**: named value asked once before a run. Secrets stay masked. Some are files.
  Some are relative dates (`+14d`).
- **Run**: status (passed, healed, provisional, needs you, failed), started at, duration,
  inputs used, one screenshot per step (filmstrip), outputs (CSV/JSON when the workflow
  extracts a table), "0 model calls" when nothing used AI.
- **Heal**: a step whose target moved. Shows golden vs actual, old vs new target. Keep or
  Revert. Auto-kept after 3 clean runs.
- **Needs you**: a paused run asking the person to act (log in, enter a code, solve a bot
  check, press the irreversible button themselves) with a deadline (default 120 min).
- **Capture**: recording session in Bao's Chrome. A floating capture bar. Steps stream in
  as you act. Passwords never stored. "Pick list" lets you select a table to extract.
- **Logins**: import one site's login cookies from your Chrome, per site, on click.
- **Settings**: heal policy, runs before a heal is kept, wait timeout, remote agent
  access (off by default, ask before each run), helper permissions (Accessibility,
  Screen Recording), model (Cursor account / API key / none).

## Real and realistic data (use it, no lorem ipsum, no "Jane Doe")

Real workflows from the owner's library:
- "Set up Google OAuth for 五秒" - Google Cloud console, 14 steps, 11 inputs, passed
  Nov 1 9:35 PM. Steps: Click "Get started", Type the app name (五秒), Open "User support
  email", Pick owner@example.com, ... Click "Create".
- "Create production Google OAuth client for 五秒" - needs you (Nov 1 7:08 PM).
- "Instacart: Costco Kirkland organic blueberries" - add to cart, stops before checkout.
- "agent-browser" - 5 runs today, all passed.

Add plausible prosumer ones so the library has 9 to 12 items:
- "Download Chase statement" (monthly, extracts a PDF), "Renew CA vehicle registration"
  (DMV, stops before Pay), "Con Edison - download last bill", "Book Equinox class"
  (Reserve needs you), "Export Stripe payouts to CSV" (extract table), "File USCIS
  case status check", "Fidelity 1099 download" (yearly).

Times: today is Thu Nov 5 2026, evening. Mix statuses: mostly passed, 1 healed waiting
to be kept, 1 needs you (live, waiting), 1 failed (page changed, with a clear report).

## Current app and its problems (from a review of the running app)

Screenshots of today's app: `/Users/owner/dev/firstmate/data/bao-desktop-redesign/current/*.png`.
Open them. Findings to design away from:

1. Nav has 9 flat items (Library, Capture, Teach, Runs, Live, Heals, Replay, Logins,
   Settings). Capture vs Teach overlap. Replay's page is titled "Run". Runs and Live share
   one icon. Plumbing sits beside tasks.
2. Developer copy leaks to a non-technical user: bundle ids, `bao mcp`, AT-SPI,
   `BAO_REMOTE_MCP=1`, raw selectors like `id _0rif_mat-input-0`, input names
   `{{text}} {{text2}} ... {{text11}}`, the badge "expect".
3. Library cards: every thumbnail is a gray placeholder; titles truncate with no way to
   read them; 11 input chips per card; status legend relies on small color dots.
4. Runs: rows are not sorted by time; raw run ids eat a column; "0 model calls" pill on
   every row; wrapped workflow names center-align; the row button's accessible name is the
   run id instead of the workflow name.
5. Workflow detail: every step repeats "If this step misses [select] / Try / Run from
   step N"; tiny letterboxed screenshots; "Guide me" wraps to two lines.
6. Settings: one long form with no sections; a checkbox floats in the middle, far from its
   label; full-width selects for 3 short choices.
7. Heals empty state renders an empty bordered box. Filter buttons show no selected state.
8. When one stored workflow is invalid, the whole Library shows "No workflows yet". Any
   design should show an error that names the bad workflow and how to fix it.
9. Footer status ("helper off", "no model", "cursor account") is cryptic.

## What each mock must contain

One self-contained HTML file at
`/Users/owner/dev/firstmate/data/bao-desktop-redesign/variant-<name>.html`.
Inline CSS and inline SVG. No JS frameworks, no build. System fonts preferred; one Google
Fonts `<link>` is allowed if the direction depends on a typeface. No external images.
Draw page screenshots (golden shots, filmstrip frames) as small inline-SVG or CSS
wireframes of the real site (Google Cloud console, Instacart, DMV), not gray boxes.

Render each screen inside a macOS window frame (traffic lights, window title "Bao"),
1280 x 820, centered on a neutral backdrop. A screen switcher sits OUTSIDE the window,
visibly not part of the design (small neutral pill bar above it). Select a screen with
`?screen=<id>` and keep the URL in sync. Screens, with these exact ids:

1. `home` - the first screen. What needs attention plus the workflow library.
2. `workflow` - one workflow ("Renew CA vehicle registration" or the Google OAuth one):
   steps, inputs, heal policy, run button, recent runs.
3. `run-live` - a run in progress, paused on "needs you" (Equinox: press Reserve
   yourself, or DMV: press Pay yourself). Show the live step progress.
4. `run-failed` - a finished failed run report: which step, golden vs actual, why, what
   to do next (re-record step, try again, open the page).
5. `heal` - review a heal: golden vs actual, old vs new target, Keep / Revert.
6. `capture` - recording in progress: steps streaming in, the capture bar, a masked
   password step, Stop and save.
7. `settings` - grouped settings including helper permissions and remote access.

Also show, somewhere sensible, the invalid-workflow error from finding 8 and an empty
state for a brand-new user (can be a toggle or a small inset on `home`).

## The floor (every direction clears it; it is not a style axis)

From `better-interface`: every control has an accessible name and a visible focus ring;
keyboard reaches everything; `prefers-reduced-motion` respected; nothing clips at a
narrow window (check 720 px wide inside the frame, and that the page reflows when the
frame shrinks); text contrast passes (4.5:1 body, 3:1 large and UI); no state carried
by color alone (status always has a word or icon); destructive actions are distinct and
confirmed; truncated text has a way to see the full value; errors name a way to recover;
semantic colors used only for their meaning.

## Skills to load before designing

The `jakubkrehel/skills` collection is installed. Read these SKILL.md files and follow
their rules and exact values (open their reference files when a rule points to one):

- `~/.agents/skills/better-layout/SKILL.md`
- `~/.agents/skills/better-typography/SKILL.md`
- `~/.agents/skills/better-colors/SKILL.md`
- `~/.agents/skills/better-ui/SKILL.md`
- `~/.agents/skills/better-writing/SKILL.md`
- `~/.agents/skills/better-accessibility/SKILL.md`
- `~/.agents/skills/variant/SKILL.md` (for the "different answers, not different tints" rule)

## House rules

- Never use the em dash character in any copy. Use a plain "-".
- Plain English copy. Short words. Active voice. No jargon a non-technical person would
  not know. Keep technical detail behind a disclosure for power users.
- Be picky about pixels. After building, screenshot every screen with Playwright
  (`/Users/owner/dev/bao-mac-m1/node_modules/playwright`, chromium, viewport 1440 x 960,
  `file://` URL with `?screen=<id>`), plus `home` at 720 px window width. Open every
  screenshot and fix anything that looks off: overflow, misalignment, clipped text, bad
  wrapping, weak contrast, uneven spacing. Repeat until clean.
- Save screenshots to
  `/Users/owner/dev/firstmate/data/bao-desktop-redesign/shots/<name>/<screen>.png`.
- Do not edit the Bao repo. Do not commit anything.
