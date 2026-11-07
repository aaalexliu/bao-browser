# Test Bao on a Mac

Bao is already installed. For a rebuild, see [Build Bao on a Mac](mac-build.md).

## Open

Open Bao from Finder. Double-click `/Applications/Bao.app`. Do not use Terminal.

The Bao window has no address bar. Runs opens first. The sidebar has Runs, Workflows, and Settings.

Check helper presence and the chosen route against [Which grant each job needs](permissions.md#which-grant-each-job-needs).

## Record

1. Click **Workflows**, then **Record**.
2. Click **Start capture**. A second window opens on the fixture.
3. Type a made-up username, such as `ada`.
4. Type a made-up password. Click **Log in**.
5. Drag a throwaway file from Finder onto **Drop a file here**.
6. Click **Stop and save**.

Library shows the new workflow and password. The file path is not in it.

## Replay

1. Open it, then click **Run**.
2. Type a different username and choose a different file. Click **Run**.
3. Move and resize the replay window.
4. Run it again with another username and another file.

Both runs pass. The fixture greets the username from that run. The file name is the one from that run. The second run stays in the window you just moved.

## Optional

- Place order or Reserve pauses on **needs you** before that button. Bao does not press it.
- Click **Pick list** on the capture bar, then save. The run page has a **CSV** link.
- A relative date such as `+14d` replays as that day.
- A bot check pauses on **needs you**. Bao does not try to solve it.
