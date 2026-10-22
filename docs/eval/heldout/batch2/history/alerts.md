# alerts v1

This is the frozen trail from the first batch 2 capture. The scored fixture is `../alerts.v2.json`.

The keep step is `e6`, the click on "Click for JS Alert". The event has a css path, and `beforeUrl` and `afterUrl` are both `https://the-internet.herokuapp.com/javascript_alerts`. It has no dialog, no subtree change, and no result text. The heading clicks and "Click for JS Confirm" have that same shape. The effect filter drops `e6` along with those clicks. Condense keeps no step, and replay never clicks the button, so the body never contains "successfully clicked an alert".

v2 records those clicks again with the dialog recorder. The alert click stores the dialog message and the result text, so the step stays.
