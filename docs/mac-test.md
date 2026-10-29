# Test Bao on a Mac

Bao is already installed. For a rebuild, see [Build Bao on a Mac](mac-build.md).

## Open

Open Bao from Finder. Double-click `/Applications/Bao.app`. Do not use Terminal.

The window title is **Bao**. There is no address bar. Library is the first screen. The sidebar lists Library, Capture, Teach, Runs, Heals, Replay, Logins, and Settings. The footer reads **helper ok** when both grants are on. It also reads **AX press ready**, **window capture ready**, **live Chrome ready**, and **MCP driver ready**.

Leave Screen Recording on for window capture and the MCP driver. Live Chrome stays ready with Accessibility alone. If the footer reads **helper needs permission**, allow the missing grant and open Bao again.

## Record

1. Click **Capture**.
2. Click **Start capture**. A second window opens on the fixture.
3. Type a made-up username, such as `ada`.
4. Type a made-up password. Click **Log in**.
5. Drag a throwaway file from Finder onto **Drop a file here**.
6. Click **Stop and save**.

Library shows the new workflow. The password is not in it. The file path is not in it.

## Replay

1. On the card, click **Run**.
2. Type a different username and choose a different file. Click **Run**.
3. Move and resize the replay window.
4. Run it again with another username and another file.

Both runs pass. The fixture greets the username from that run. The file name is the one from that run. The second run stays in the window you just moved.

## Optional

- Place order or Reserve pauses on **needs you** before that button. Bao does not press it.
- Click **Pick list** on the capture bar, then save. The run page has a **CSV** link.
- A relative date such as `+14d` replays as that day.
- A bot check pauses on **needs you**. Bao does not try to solve it.
