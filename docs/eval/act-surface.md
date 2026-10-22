# Act surface

Signed `Bao.app` (`dev.bao.desktop`, certificate `bao dev signing`) posts **You need to act**. Notification Center draws the banner, so this note has no picture of it. The delivered list is `getDeliveredNotificationsWithCompletionHandler` inside that app. The nested helper kept CDHash `e2ad7477d8f989484c3d0ef8a2598561844127bf`.

The check used a fresh home and a workflow whose only step is login, opened on this server's fixture. Replay raised the act, then failed with `waiting for you to log in` when the wait ended.

Authorization was already `denied`. `prompt` was false. Preferences were left as they were.

The app log for that post:

```
bao notify badgeLabel=!
bao notify authorization denied
bao notify delivered count=0
```

The delivered list was empty, so there is no title line and no body line. The socket reply was `authorization` `denied`, `delivered` false, `titles` `[]`, `bodies` `[]`, `badge` `!`, `bundleId` `dev.bao.desktop`.

`NSDockTile.badgeLabel` read back `!` after the set, and empty after clear. A second post, while `badgeLabel` was still `!`, read the Dock item titled Bao through the helper. `AXStatusLabel` is null. `AXValue` is empty. The badge proof is the tile label.

The panel shot is one `SCContentFilter` on `desktopIndependentWindow` for window `146743`, pid `45602`, bundle `dev.bao.capturebar`, title `Bao capture`, 380×444. The window shows the red title **You need to act**, with Pause, Discard, and Stop and save. No other window was captured.
