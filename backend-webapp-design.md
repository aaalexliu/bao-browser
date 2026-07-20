# Bao - Backend & Web App Design

> Parent doc: [[product-design-v1]] (architecture, IR, storage & privacy, the Executor seam).
> Prior milestones: [[m1-design]] (cross-nav state machine). Related: [[t16-dashboard-design]]
> (the local full-page dashboard this web app mirrors online).
> Status: the extension is local-only and shipping to the Chrome Web Store as launch #1
> (QA/dev wedge, no backend). This doc is the backend + web app that unlocks launch #2:
> readable-step compilation, cross-device sync, and **workflow sharing**.

## Goal

Add a backend and a web app **without breaking the thing that makes Bao trustworthy**.
Three new capabilities, in dependency order:

1. **Compile** (M2) - turn a raw recording into clean, readable, well-labelled steps via
   one hosted LLM call. This is the non-technical trust surface promised in the parent doc.
2. **Sync** - an account so a user's workflows live beyond a single browser profile.
3. **Share** - teams/workspaces so a workflow authored by one person can be run by others.

## The stance (non-negotiable): local-first, backend is additive

The extension must keep working **fully offline, with no account**, exactly as it does at
launch #1. The backend is a set of *opt-in* enhancements layered on top, never a dependency
the runtime needs.

> **Replay never touches the backend.** Replay is deterministic code running in the user's
> logged-in session, in the extension. The server is for *authoring, storage, and
> collaboration* - not execution. (It structurally cannot replay: it has neither the user's
> session nor the page. See [§ Two surfaces](#two-surfaces).)

Why this is load-bearing: the privacy wedge ("your recordings stay on your machine") is the
whole pitch against browzer/agents. The moment the backend becomes mandatory, that pitch is
gone. Keeping it additive lets the landing page stay honest (local-first, cloud is opt-in)
and keeps the CWS story clean until data transmission is actually a feature the user turned on.

## What crosses the wire, ever

This table is the contract. Nothing leaves the device except these, and each is an explicit,
inspectable action.

| Payload | When | Contains | Never contains |
|---|---|---|---|
| **Redacted masked trace** | user hits Compile (opt-in) | coalesced events, ranked selectors, aria/text grounding, viewport dims | secret values (T1-masked at capture), full screenshots, DOM subtrees |
| **Workflow IR** | user enables Sync / Share | the readable steps, selectors, labels, literal non-secret `value`s | anything a `sensitive` step withheld - those never had a value to sync |
| **Audit bundle** (opt-in) | user explicitly shares a run | golden/actual screenshots for chosen steps, after a redaction pass | steps the user excludes; unredacted frames |

Two consequences that drive the rest of the design:

- **Secrets are already safe.** T1 masking means a `sensitive` step never had a stored value,
  so nothing downstream (compile, sync, share, audit) can leak one. This is done, not future.
- **Non-secret literal values are the real sharing hazard.** A recorded `value` like
  `qa@acme.com` or `1 Market St` is not a "secret" by T1's definition but is still personal.
  Sharing a workflow verbatim would leak it. → sharing is coupled to **parameterization**
  (see [§ Share](#3-share-teams--the-value-leak-problem)).

## Two surfaces

| | Extension (exists) | Web app (new) |
|---|---|---|
| Runtime | **Yes** - records + replays in the live session | **No** - cannot access the user's tabs/session |
| Library | local dashboard ([[t16-dashboard-design]]) | the same library, synced + team-shared |
| Run history / filmstrip | local IndexedDB | optional synced audit bundles |
| Team / sharing / billing / admin | - | **Yes** - the collaboration + account home |
| Marketing / install / docs / privacy | - | **Yes** - the landing site (`site/`) folds in here |

The web app is a **management and collaboration surface**, plus the public marketing site. To
actually *run* a shared workflow, a teammate installs the extension, signs in, and the
workflow syncs down; the web app's "Run" button is a hand-off that focuses the extension.
This division is not a limitation to paper over - it *is* the security model: the org's
browser automation only ever executes in a real human's authenticated session, never on a
server holding everyone's credentials.

## 1. Compile (M2) - the readable-steps service

A stateless endpoint. Input: the redacted masked trace. Output: a clean `Workflow` IR.

```
POST /v1/compile   { trace: RawTrace }  ->  { workflow: Workflow, tokens, model }
```

The compiler does what the parent doc's "Backend" row lists: coalesce keystrokes into one
`input`, drop noise, infer `waitFor` from navigations, detect a login and insert
`waitForUser`, **write the plain-English `label` per step** (the trust surface), and order
selectors by stability. It returns the IR shape already defined in [[product-design-v1]];
the client shows it for review and saves it locally.

- **Model**: an Anthropic Claude model with structured JSON output. Default **Claude Sonnet 5**
  for the compile pass (fast, cheap, strong at structured extraction); escalate to
  **Opus 4.8** only for traces the first pass returns low-confidence on. The large, fixed
  system prompt (the IR schema + labelling rules) is a prompt-caching candidate - it's
  identical across every request.
- **Stateless & keyless-to-the-client**: the backend holds the LLM key (parent doc decision);
  the extension never sees it. The trace is not persisted after the response returns unless
  the user is a Sync user who opted into storing it.
- **Degrades cleanly**: if compile is unavailable or the user is offline, the extension falls
  back to the **local heuristic labels** it already generates today (launch #1 proves these
  are serviceable). Compile makes labels *better*; it is never a hard gate on saving a workflow.

## 2. Sync - accounts + workflow storage

- **Auth**: Google OAuth (users are already in Chrome). Web app uses standard OIDC; the
  extension uses OAuth PKCE and stores the token in `chrome.storage`. The web app origin is
  listed in `externally_connectable` so the site can hand off to the extension.
- **Unit of sync**: the `Workflow`. Small JSON, already versioned (`workflow.version` bumps on
  every edit - the dashboard does this today).
- **Conflict model**: last-write-wins keyed on `version`. Client pushes with the base version
  it edited; server rejects a stale push (409) and the client pulls + re-applies. Workflows
  are single-author-edited in practice, so this is sufficient; no CRDT needed. A rejected push
  surfaces as "this workflow changed elsewhere - reload."
- **What syncs**: the IR only. **Run history and screenshots stay local by default** (bulky +
  the strongest part of the privacy story). Synced audit bundles are a separate opt-in (§4).
- **Storage**: Postgres, one `workflows` row per workflow with the IR as `jsonb` + a
  `content_hash` for cheap change detection. No blob store needed until audit sharing.

## 3. Share - teams & the value-leak problem

### Workspaces

Standard team model: a **Workspace** has **Members** with roles `owner | editor | viewer`, and
owns a shared **workflow library**. Sharing is either into a workspace library (team-visible)
or via a **share link** that forks a copy to the recipient's library. Fork-on-import is the
default - the recipient owns their copy and can edit/heal it without affecting the origin.

### The hazard: literal values

A workflow's steps carry literal `value`s the author typed. Secrets are already masked (T1),
but personal-but-not-secret values (email, address, account numbers below the T1 net) would
travel in a naive share. **You cannot ship sharing without addressing this**, so sharing
pulls **parameterization** (the M4 "variables" item) forward as its prerequisite:

- **Share review**: sharing opens a review that lists **every literal `value` in the workflow**
  and, for each, offers: *keep* (ship the literal), *parameterize* (replace with a
  `{{variable}}` the runner fills at replay), or *blank* (clear it). Nothing is shared until
  the author has seen the list. Defaults bias safe: values that look like PII (email/phone/
  address shapes) default to *parameterize*.
- **Variables in the IR**: `Workflow.variables` already exists as an empty array in the schema
  (parent doc) precisely for this. A shared workflow declares its variables; the recipient is
  prompted for them (or maps them to their own) before first run. This is the same mechanism
  that later powers "run the workflow I just recorded with different inputs."
- **Sensitive stays sensitive**: a `sensitive` step shares as a sensitive step - still no
  value, still "you enter it at replay." The guarantee is identical across the share boundary.

### Audit sharing (§4 preview)

Sharing a *run* (filmstrip) is separate and heavier because screenshots can contain anything
on-screen. It is always explicit, per-run, and runs a **redaction pass** (mask the same
sensitive regions + a manual blur/exclude step) before any frame is uploaded. Off by default.

## Data model (server)

```jsonc
User      { id, email, name, createdAt }
Workspace { id, name, ownerId, plan, createdAt }
Member    { workspaceId, userId, role: "owner"|"editor"|"viewer" }
Workflow  { id, workspaceId, authorId, version, contentHash,
            ir: <Workflow IR from product-design-v1>,     // jsonb
            visibility: "private"|"workspace",
            createdAt, updatedAt }
ShareLink { id, workflowId, token, forkOnImport: true, expiresAt }
AuditBundle { id, workflowId, runId, redacted: true,      // opt-in only
              frameRefs: [objectStoreKey], createdAt }     // blobs in object storage
```

The `ir` blob is the same shape the extension already produces and reads - the server treats
it as opaque JSON it stores, hashes, and serves. No server-side IR logic beyond compile.

## API sketch

```
POST /v1/compile                 -> { workflow }                 # stateless, no auth needed for anon tier
GET  /v1/workflows               -> [{ id, name, version, ... }] # workspace library
GET  /v1/workflows/:id           -> { ir }
PUT  /v1/workflows/:id  {ir,base}-> 200 | 409 stale             # version-checked push
POST /v1/workflows/:id/share     -> { shareLink }               # after share-review client-side
POST /v1/import/:shareToken      -> { workflow }                # fork-on-import
POST /v1/workflows/:id/audit     -> { bundle }                  # opt-in, pre-redacted client-side
GET  /v1/workspaces/:id/members  -> [...]                       # + invite/role CRUD
```

Redaction and share-review happen **client-side in the extension** before anything is POSTed -
the server never sees an unreviewed value or an unredacted frame. The server enforces
authz (workspace membership/role) but is deliberately dumb about content.

## Tech choices

Bias: simplicity, robustness, and a small surface that a solo maintainer can run.

| Concern | Choice | Why |
|---|---|---|
| API | one stateless service (Node/TS, shared types with the extension) | reuse the `Step`/`Workflow` types verbatim; no schema drift |
| DB | Postgres (`workflows.ir` as jsonb) | boring, durable, jsonb fits the IR; no CRDT/graph needed |
| Blobs | object storage (S3-compatible), only for opt-in audit bundles | keep the hot path DB-only |
| Auth | Google OAuth / OIDC; PKCE from the extension | users already have Google; no password storage |
| LLM | Anthropic Claude (Sonnet 5 default, Opus 4.8 escalation), JSON output + prompt caching | quality on the label surface; caching amortizes the fixed schema prompt |
| Hosting | provider-agnostic container (stateless API scales horizontally) | the only stateful pieces are Postgres + blob store |
| Web app | server-rendered app reusing the dashboard's component language | the online library mirrors [[t16-dashboard-design]] |

Remote-code note (CWS): the extension calls the API over `fetch`; it never loads executable
code from the server. MV3-compliant, and it keeps the "power" out of the client.

## Migration from local-only

1. **Anonymous compile first.** Ship `/v1/compile` before accounts - the extension can call it
   with no login (rate-limited by install id). Instantly upgrades label quality for launch-#1
   users, zero account friction, and exercises the one novel service in isolation.
2. **Add sign-in → sync.** On first login, the extension offers to push existing local
   workflows up. Local remains the source of truth; sync is a mirror. Sign out → fully local
   again.
3. **Add workspaces → share.** Sharing ships only once parameterization + share-review are in,
   because (per §3) it is unsafe without them.

Each step is independently shippable and independently reversible.

## Rollout milestones

```
M2   compile service (anonymous) + extension "Compile" action + review UI
M5a  Google auth + workflow sync (opt-in) + web app library (read/manage)
M5b  parameterization / variables in the IR + the runner's variable prompt   (prereq for share)
M5c  workspaces + members + share-review + fork-on-import
M5d  opt-in synced audit bundles (redaction pass) + shared filmstrip viewer
```

(M4 self-healing from the parent doc is orthogonal and can interleave; M5b is really "M4
parameterization" pulled forward because sharing needs it.)

## Risks & open questions

1. **Selector portability across accounts.** A workflow authored on one login may target
   tenant-specific ids. Anchored capture + healing (M4) mitigate, but shared workflows will
   need re-heal on the recipient's instance more often than local ones. The share-review is
   also the natural place to warn "this may need re-recording on your account."
2. **Compile trace still leaks structure.** Even redacted, a trace reveals which internal app a
   user automates (URLs, aria labels). For gov/health buyers this may matter → offer a
   self-hosted compile endpoint for enterprise, same API.
3. **Abuse of anonymous compile.** Rate-limit by install id + a proof-of-work or soft cap;
   the endpoint is an LLM cost sink otherwise.
4. **Audit blob liability.** Screenshots are the highest-risk payload. Keeping them opt-in,
   per-run, client-redacted, and off by default is deliberate - revisit only with demand.
5. **Web app "Run" hand-off UX.** Deep-linking the site → extension → correct workflow is
   fiddly (focus, install-state, which profile). Prototype early.

## Non-goals

- **Server-side replay / a cloud browser.** That would require holding user credentials and
  re-creates the exact trust problem Bao avoids. Replay stays in the user's session, forever.
- **Real-time multiplayer editing.** Workflows are single-author artifacts; version LWW is enough.
- **Syncing run history / screenshots by default.** Local by default; audit bundles are the
  narrow, explicit exception.
- **Making any of this a dependency of replay.** The extension must always work offline,
  account-free, exactly as at launch #1.
```
