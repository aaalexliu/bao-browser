# Sync, share, and run Bao workflows

Bao keeps a workflow as schema v2 JSON on the Mac that recorded it. A registry lets that Mac meet your other Macs, and a web app lets you share or list a workflow. Replay still happens on a device. The server never sees a cookie, a secret, or an unredacted screenshot.

## Run it locally

From the repo root, with Node 22 or newer for the web app:

```bash
npm install
npm --prefix web install
npm --prefix web run dev
```

The dev server uses PGlite under `web/.data/pglite` and files under `web/.data/blobs` when `DATABASE_URL` is unset. `BAO_AUTH_STUB=1` (or any non-production run) returns the email sign-in link in the response instead of sending mail. The GitHub button signs you in as a verified stub user.

Pair a Mac from Devices, then:

```bash
npm run bao -- sync pair CODE --server http://127.0.0.1:3000 --home ~/.local/share/bao
npm run bao -- sync --home ~/.local/share/bao
```

`bao sync` pushes local changes, pulls newer versions, and refreshes the device list. The first sync copies `workflows/`, `runs/`, and `settings.json` to `backups/before-sync-<time>/` before anything is sent. A newer remote version wins. The copy you had is written to `conflicts/<id>.json` and shown under Settings → Sync. The device token is stored in `sync.json` mode `0600` and is not returned by the local app's `/api/state`.

Settings → Sync shows the paired devices and item counts per category. Secrets are inputs of type `secret` with no default. Typed secret values, cookie headers, and screenshot bytes are dropped before a push. A payload that still contains them is rejected.

## Share a workflow

On the workflow page, copy a view link or an install link. The shared copy has already had emails, phone numbers, street addresses, and secret defaults removed.

An install link asks the setup questions, the same idea as Shortcuts. Secret and file answers are not accepted. An answer that looks like an email or a card number is dropped. Other answers become defaults on the recipient's private copy only.

Open a workflow from the desktop library or with:

```bash
npm run bao -- open bao://workflow/<id>
```

Replay → Re-run with past inputs fills the non-secret fields from the last run. Passwords are not kept.

## List a workflow

Publish shows a preview of what would be public: the diff of cleared values, the domains the workflow touches, the last replayed-green date, and a verified-author badge when the account is verified.

Listing stays disabled until a device replays that redacted copy:

```bash
npm run bao -- sync review <id> --inputs inputs.json
```

`bao sync review` replays on this Mac. Only a passing run is reported, and the report is the hash of the redacted document. Confirm on the preview page after that. The marketplace page is the public catalog. Fork asks the same setup questions. Report sends a reason. There is no payment step.

Example workflows (a fixture sign-in, a row pick, a username, a file upload, Wikipedia search, and a public form) ship private. They show up in the marketplace only after that replay-and-confirm step.

## MCP

`bao mcp` exposes four tools no matter how many workflows you add:

| Tool | What it returns |
| --- | --- |
| `search_workflows` | At most 5 ranked hits from this Mac and the registry. Each hit includes its input schema. |
| `describe_workflow` | The steps, the input schema, and a `bao://workflow/<id>` link. Secret defaults are omitted. |
| `run_workflow` | `ok`, `needs_human`, `needs_signin`, or `failed` with a reason, plus a one-time resume token. `rerun: true` reuses past non-secret inputs. |
| `get_run` | A stored outcome. |

A missing secret or file, or a heal that is waiting for approval, is `needs_human` and does not leave the device. A failed sign-in step is `needs_signin`. Pass the resume token with the missing input to run again. The token is deleted when it is used.

A scripted client searched for "sign in", described `agent-sign-in`, and ran it as grace. The tool list stayed these four names. Search returned four hits, under the cap of five, and each hit included its input schema. The run result was:

```json
{
  "outcome": "ok",
  "workflowId": "agent-sign-in",
  "receipts": [
    { "id": "user", "status": "passed", "readBack": "grace" },
    { "id": "pass", "status": "passed", "readBack": "[secret]" },
    { "id": "go", "status": "passed", "readBack": "Welcome grace" }
  ],
  "stops": [],
  "link": "bao://workflow/agent-sign-in"
}
```

The password never appears in that result. The full redacted exchange is the live-test artifact `agent-transcript.json`.

## Deploy

Do this yourself when you want a hosted registry. This repo does not create the project or the stores.

1. Open [vercel.com/new](https://vercel.com/new) and import this git repository.
2. Framework preset: Next.js.
3. Root Directory: Edit, then `web`.
4. Environment variable: `BAO_AUTH_STUB` = `1` if you want the email link returned in the API instead of mail. Leave it unset in production when a real mailer exists. The GitHub route stays a stub until you replace it, and returns 501 in production without `BAO_AUTH_STUB`.
5. Deploy.
6. In the project, Storage → Create → Blob. Choose Private. Connect it to the project. That sets `BLOB_STORE_ID` for the private redacted PNGs. Do not pick a public store.
7. Marketplace → Neon → the free plan. Read the plan, then accept. Neon injects `DATABASE_URL`. Do not choose Vercel Postgres or KV. Those products are sunset.
8. Redeploy so the function sees `DATABASE_URL` and the Blob store.

The app uses the Neon serverless driver when `DATABASE_URL` is a hosted Postgres URL, and the `pg` driver for `localhost`. Blob uploads use the private store when `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set. With neither, the files stay on disk, which is the local path above.
