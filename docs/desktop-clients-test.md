# Test Bao through desktop clients

With Bao open and ChatGPT in **Codex** mode, run `node scripts/test-desktop-clients.mjs --output /absolute/local/evidence` using a new local output directory. It needs `chrome-devtools-axi` on PATH and Bao registered at its installed launcher. It reads X, GitHub, Gmail and LinkedIn with both `copy` and `bao`; add `--site x.com` for a focused pass. It uses your sign-ins, creates chats and Library runs, restarts ChatGPT with localhost CDP, then restores a normal launch. It leaves your running Chrome alone and requests no Mac grants.

Keep the output on this Mac. Open the conversation/tool-card, site and Bao receipt pictures, then read each `result.json`; a captured run does not prove a working sign-in. A nonzero exit needs review. Claude Desktop **4.23118.0** rejects CDP launch flags, so this runner does not cover it.
