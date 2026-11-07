# Test Bao on a Mac

Bao is already installed. For a rebuild, see [Build Bao on a Mac](mac-build.md).

## Open

Open Bao from Finder. Double-click `/Applications/Bao.app`. Do not use Terminal.

The Bao window has no address bar. Runs opens first. The sidebar has Runs, Workflows, and Settings.

Check helper presence in Settings against [Which grant each job needs](permissions.md#which-grant-each-job-needs). Chrome agents need no Mac permission grant.

## Record

1. Click **Workflows**, then **Record**.
2. Click **Start capture**. A second window opens on the fixture.
3. Type a made-up username, such as `ada`.
4. Type a made-up password. Click **Log in**.
5. Drag a throwaway file from Finder onto **Drop a file here**.
6. Click **Stop and save**.

Library shows the new workflow. The password is not in it. The file path is not in it.

## Replay

1. Open it, then click **Run**.
2. Type a different username and choose a different file. Click **Run**.
3. Move and resize the replay window.
4. Run it again with another username and another file.

Both runs pass. The fixture greets the username from that run. The file name is the one from that run. The second run stays in the window you just moved.

## Desktop clients

With Bao open and ChatGPT in **Codex** mode, run `node scripts/test-desktop-clients.mjs --output /absolute/local/evidence` using a new local output directory. It needs `chrome-devtools-axi` on PATH and Bao registered at its installed launcher. It reads X, GitHub, Gmail and LinkedIn with both `copy` and `bao`; add `--site x.com` for a focused pass. It uses your sign-ins, creates chats and Library runs, restarts ChatGPT with localhost CDP, then restores a normal launch. It leaves your running Chrome alone and requests no Mac grants.

Keep the output on this Mac. Open the conversation/tool-card, site and Bao receipt pictures, then read each `result.json`; a captured run does not prove a working sign-in. A nonzero exit needs review. Claude Desktop **4.23118.0** rejects CDP launch flags, so this runner does not cover it.

## Optional

- Place order or Reserve pauses on **needs you** before that button. Bao does not press it.
- Click **Pick list** on the capture bar, then save. The run page has a **CSV** link.
- A relative date such as `+14d` replays as that day.
- A bot check pauses on **needs you**. Bao does not try to solve it.
