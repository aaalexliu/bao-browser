# What Bao asks permission for

The current [agent-browser pass-through](agent-browser-engine.md#pick-an-engine-and-profile) uses a marked profile copy and page screenshots through CDP. It needs no Accessibility, Automation, or Screen Recording grant. The older daily-Chrome driver is retired. Bao no longer shows its permission card, footer warnings, or Automation Allow button. The helper's optional native-app and remote-debugging CLI features remain below. A grant for one feature does not grant another.

## The Chrome remote-debugging toggle

This is the checkbox **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`. You can flip it in Chrome or use `bao remote-debugging on` and `bao remote-debugging off`. The pass-through does not use this toggle. Chrome enforces it: while it is off, no local program can open a debugging connection to that browser. While it is on, Chrome listens on this Mac only (`127.0.0.1`) and will still ask before each connection. The checkbox is a Chrome preference. It stays as you left it across restarts until you clear it. Leaving it on costs nothing by itself. The automation banner appears only while a connection is actually open.

## BaoOSHelper Accessibility

The optional native-app MCP driver uses the helper's Accessibility access to read and press controls in Calculator and TextEdit. The separate `bao remote-debugging on|off` CLI uses it to read and set Chrome's debugging checkbox by pid. Owned-browser replay window placement also tries the helper after CDP as a best-effort step; missing access does not block replay. Chrome agents need none of these helper paths. macOS grants Accessibility to BaoOSHelper, not to `node` or the product window.

If you choose a feature that needs Accessibility, enable BaoOSHelper in System Settings > Privacy & Security > Accessibility. If its row is missing, use the + button to add `Bao.app/Contents/Resources/BaoOSHelper.app`. Keep the signed helper identity described in [Rebuild with an existing grant](mac-build.md#rebuild-with-an-existing-grant).

## Automation for Google Chrome

Only the separate `bao remote-debugging on|off` command uses this grant. Its helper opens `chrome://inspect/#remote-debugging`, checks the URL, and restores the selected tab through Apple Events to one Chrome pid. It never runs JavaScript through Apple Events. A toggle that already matches the requested state does not ask. Running the CLI can ask for Automation when the toggle must change; Chrome agents and app status never ask or open Chrome for it.

The outer app's [`NSAppleEventsUsageDescription`](../desktop/packaging/macos/Info.plist) and the [helper's purpose string](../desktop/os-helper-macos/Info.plist) name that CLI feature. They permit a future prompt, not a grant or a reset of a prior denial. macOS can attribute an installed nested-helper request to Bao (`dev.bao.desktop`) or a standalone request to BaoOSHelper. If you choose to use this CLI after denying Automation, open System Settings > Privacy & Security > Automation and enable Google Chrome under Bao for the installed app, or under BaoOSHelper for a standalone request. No Automation grant is needed for normal Chrome agents.

## Which grant each job needs

The helper reports only two optional capabilities. The retired `ax-press` and `live-chrome` rows no longer describe an agent feature and have been removed. Their underlying helper commands remain available to the explicit CLI and native-app driver.

- **Window capture** (`window-capture`) supplies `bao mcp-ax` with window pictures through `shot`. It needs Screen Recording, not a Chrome page screenshot grant.
- **Native-app MCP driver** (`mcp-ax`) drives Calculator and TextEdit through `bao mcp-ax`. It uses Accessibility and Screen Recording to observe and act on those apps, not Chrome.

Both API rows have `optional: true`; neither creates a footer warning, onboarding card, or permission button. These rows do not read the Screen Recording grant and cannot report whether it is on. Without the helper or outside macOS, `helper.label` reads `helper off`. With the helper present on macOS, it reads `helper available`, regardless of grants. That label reports presence, not native-app readiness. Settings shows helper presence and states that Chrome agents need no Mac privacy grant.

The separate remote-debugging CLI still checks Accessibility before changing Chrome's checkbox and retains its Automation gate. Extension replay has its own site grant. Neither is a required helper capability.

`shot` is the only helper command that captures pixels from macOS. It remains an explicit opt-in for legacy OS tools. The generic `permissions` command reports Accessibility and preflights Screen Recording without prompting. The explicit diagnostic commands `windows` (WindowServer enumeration) and `permissions --prompt` can also check or request Screen Recording; the remote-debugging CLI's Chrome wrapper refuses all three. Normal `nodes`, `press`, `hit`, `focus`, and remote-debugging toggle calls use AX window bounds, never WindowServer window lists or screen capture. App status and the remote-debugging CLI use `permissions-ax`, which omits `screenCapture` from its report and does not preflight Screen Recording. The app reports `helper.screenCapture: false` without checking that optional grant. An old helper rejects that command rather than falling back to a Screen Recording check. The CLI's Chrome wrapper refuses `nodes` unless `--bundle` is exactly `com.google.Chrome`.

## Extension host grants

These belong to the Bao extension in Chrome, not to the remote-debugging connection. Chrome enforces them. Replay through the extension cannot touch a site until you choose **Only this site** or **Allow all sites** on the extension's allow page. Nothing is granted at install. A per-site grant covers that origin. An all-sites grant covers later http or https origins of that scheme. The default wait is 90 seconds; if the grant does not arrive, the run stops and asks you. The pass-through does not use this grant. `cdp-live` workflow replay is retired.

## Agent Chrome control

The current [`agent_browser` pass-through](agent-browser-engine.md#direct-mcp-commands) uses a marked profile copy. It does not attach to daily Chrome or use a host allowlist. Bao does not block final clicks. The older live driver and its policy modes are retired. Saved workflows with `driver: "cdp-live"` fail before opening Chrome, with `this workflow used the retired live driver`.

## What stays on this Mac

Pass-through runs save raw command arguments, native stdout/stderr, and readable page screenshots in Bao's local Library. They do not redact credentials or other private page content. Do not use this route for data you do not want saved locally. Page screenshots use CDP, not macOS Screen Recording. The app serves local run evidence on `127.0.0.1`, with caching off.

Historical live-driver session files, workflows, pictures, and video remain readable. Retirement does not rewrite or upload them. Their old redaction rules do not apply to current pass-through records. [Run evidence](agent-browser-engine.md#evidence) describes the current paths and failure behavior.

### Secret text in saved files

Bao strips detected secrets in owned user-value fields when it saves live trails, run records and workflows. The separate [direct MCP recording contract](agent-browser-engine.md#direct-mcp-commands) covers raw pass-through evidence outside those fields. Firstmate 009 limits replacement to the typed `USER_VALUE_FIELDS` allowlist in `shared/saved-secrets.ts`:

| Owner | Saved values checked |
| --- | --- |
| Typed workflow step or trail event | Typed values, inserting keys, field values before/after an action, date-range end values and prompt responses |
| Workflow input | Default values, including captured table cells |
| Form field or field read-back | The field's value, not its label or identity |
| Runtime record or tool event | Values inside input and argument bags, including raw tool arguments |
| Captured list or run output | Table cells and scalar output values, not headers or column definitions |
| Read-back receipt or MCP result | Unsigned receipt `expected`/`actual` before hashing, and the result's `readBack` value |
| Teaching case | Replay text/secret values and the case's secret-value list |

Bao replaces an eligible whole value with `[secret stripped]`, never a fragment inside another string. An arbitrary metadata property named `value`, `text` or `default` does not qualify. Once a real argument, default or row container is selected, its contents remain data: model-, schema- and media-shaped keys do not exempt payload values. Field structure comes first: password types and `current-password`, `new-password`, `one-time-code` or `cc-*` autocomplete tokens. Value checks cover whole values that match Luhn-valid card numbers, SSN shapes, JWTs or common API-token prefixes. Secret table columns strip their cells; harmless columns and raw headers stay intact.

These checks do not change or block live typing. Identifiers, labels, vendor/model names, selectors, URLs, templates, option definitions and all other metadata remain unchanged, even when they equal a secret or match a value check. Genuine workflow-owned bindings remain templates; a raw secret argument that looks like a template is still data. Existing markers remain unchanged. Sync, sharing and release preparation keep the shared whole-value copy; they do not run a later secret-substring or personal-data regex rewrite. Import questions follow explicit author marks and do not clear personal defaults. Outbound copies omit secret-type defaults and sensitive credential literals without refusing the whole workflow just because those fields existed. The remaining known-secret byte check can refuse a copy that still contains a collected credential. Labels and other unlisted metadata, including personal text, remain unchanged. Unmarked dropdown, radio and checkbox values remain unchanged, even when a value matches a secret pattern. A secret-marked choice field still strips its selected and default values.

Known gaps include secrets embedded in free text, unlisted metadata fields, snapshot text, prompts and responses. The sanitizer does not search those fields, even for a whole secret value. Saved runtime arguments use the associated workflow's field and input bindings. Cleanup uses those workflow links and saved argument bags when they exist. Older or orphaned files may lack that evidence. Screenshots and videos stay unchanged. Sync no longer refuses a workflow merely because its source held a secret default, credential argument, or unmarked picture. It strips credentials for the outgoing copy while preserving personal values and pictures. Pictures may come from sensitive or secret-input steps and need not be element crops or carry `redacted: true`.

When interpreting a new recording, secret-entry events become secret input slots. Their steps use stable field structure, not captured text or values, for locators. The interpreter does not infer checks from those events' effects. Other events and existing metadata stay unchanged.

Replay stops at a stripped step with “This step needs a value.” It never types the marker or sends it to healing. Supply a fresh runtime input to replace a stripped saved default, or edit the saved step and its input before replaying it.

To inspect existing saved text in one Bao home, quit active sessions and run:

```sh
bao scrub-secrets --home /path/to/bao-home
```

The command defaults to a dry run and lists the files it would change. Add `--write` to scrub them. Before changing any saved file, Bao backs up every affected original under `<home>/secret-scrub-backups/<run>/`, with private directory and file permissions. Those backups still contain the original secrets. Keep them private and remove them once you no longer need recovery. The command skips symlinks, browser profiles, settings, screenshots and videos. It also lists append-only receipt chains as skipped, with a reason, in both dry-run and write output. Those chains stay byte-for-byte unchanged and may still contain historical secrets. New receipts are stripped before hashing so their chains remain valid. Already hashed receipts, including their whole signed bodies in run and trail copies, stay unchanged. Historical secrets in those copies may remain too. Receipt-shaped objects inside user arguments, defaults or captured rows still strip as user data. `bao scrub-secrets --help` describes this limit. Invalid JSON in a file to be scrubbed stops the scrub before it writes anything. Run it again to check that the supported value fields no longer need a change.

### Sealed artifact census

Firstmate 010 makes a sealed payload read-only. Bao strips eligible text values once, before the writer computes its seal. Later saves, cleanup, heal copies, release preparation and sync copies preserve that payload. They do not rehash a changed copy. The shared owner check in `shared/saved-secrets.ts` recognizes hashed read-back records, publication previews with `documentHash`, and `sha256:` content addresses. Objects with an arbitrary `hash` property do not qualify. Receipt and preview lookalikes inside argument/default/row payloads remain user data and still strip.

`desktop/test/unit/saved-secrets-sealed.test.ts` runs this census through shared/context stripping, the shared outbound strip function, release preparation, workflow/run/trail/append writers, kept-heal copies, version heal drafts, intent evals, sync pull/heal catch-up and dry-run/write cleanup. It compares canonical payload bytes, verifies seals after each pass, and compares whole file bytes before and after cleanup. Workflow JSON can sort object keys and change outer whitespace; neither is part of a receipt or release seal. Sealed copies that still contain a collected credential can fail the outgoing known-secret check; Bao does not change their bodies to make them pass. Its composition fixture also uses the real local registry with throwaway PGlite storage, HTTP sync, share/install and release producers. It covers already-stripped defaults, `secret`/`strip`/`stripped`/`pass` collisions, whole card/token values, stable `{{password}}` bindings and physical saved copies. Browser replay must stop before typing or healing without fresh input, then type the fresh runtime value.

| Artifact | Single seal point | Payload and verification |
| --- | --- | --- |
| Read-back receipt | `ReceiptLog.append`, after whole-value stripping | Whole receipt body and `prev`; `verifyReceiptChain` verifies copies and the original chain bytes stay unchanged |
| Publication preview / review hash | `prepareImport` clears eligible values before `releaseHash`; desktop review and server preview use that same path | Released `document`; recompute `releaseHash` without changing the copy |
| Download output | `fileDigest`, after the download writes its bytes | External file bytes; compare size, SHA-256 and original bytes, not the surrounding manifest |
| Screenshot address | Proxy executors and eval capture hash the captured PNG | External PNG bytes; recompute SHA-256 and preserve the `sha256:` reference or eval `snapshot.sha256` |
| Crop address | Desktop crop capture hashes the final PNG | External crop bytes; recompute SHA-256 and preserve the content address |

The census uses a real Playwright screenshot and a fixture crop. It does not run native desktop capture or change helper grants. Image, download and video bytes remain outside text stripping; their hashes do not seal neighboring text in an event or manifest. They may contain historical private content. Existing sealed text can also retain historical secrets: cleanup never rewrites it. New eligible receipt and release values strip before sealing. No current supported desktop text writer creates a cryptographic signature distinct from these hash seals.

Sync `workflows[].hash` and outbox hashes are change-tracking baselines for editable workflows, not immutable seals. Sync and MCP materialization compute them from the saved stripped document. Editing a workflow must still make it dirty. Local version numbers, login cookie-name fingerprints, extension signal IDs, profile namespaces, auth-token hashes and panel signatures are not content seals on saved user-value artifacts. Local version books have no seal and still scrub their unsealed document copies. Credential stores, media, original-byte backups and historical receipt-chain files keep their existing exclusions.

## What each one costs in speed

Chrome agents do not wait for Mac privacy grants or the daily-Chrome debugging switch. The separate remote-debugging CLI returns at once if the checkbox already matches. Changing it needs a helper accessibility walk. An extension host grant is a separate prompt with a wait of up to 90 seconds; it is not part of the pass-through.
