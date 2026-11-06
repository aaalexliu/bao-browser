# Library

Open the test-owned app's Library and confirm its temporary home. A new Library shows `No workflows yet`. Import or record an ordinary workflow to test saved cards, search, and detail. Do not claim that a manually planted fixture proves recording.

For historical workflows with `driver: "cdp-live"`, a planted schema-valid fixture is appropriate: require a readable card and `This workflow used the retired live driver.` Open its Run form and require the same reason. A replay request must fail before opening Chrome. Do not rewrite historical records to make replay succeed.

Use a fresh `chrome-devtools-axi snapshot` or stable sidebar selector, then save and open the running app's screenshot. A component preview is not Library proof. Check search with matching, nonmatching, and cleared text when that path changes.

Pass-through sessions appear in Runs, not as new workflow cards. No `agent_browser` replay layer exists yet.
