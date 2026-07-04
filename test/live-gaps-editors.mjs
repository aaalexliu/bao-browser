// Bao — live gap suite, cat 3 (contenteditable editors, T2). §Part 3.
//
// Drives the real extension across three model-driven editors: types a unique token,
// resets with a clean page.reload() (a fresh editor guaranteed token-free), and asserts
// the token comes back via the contenteditable actuator (setEditableValue).
//
//   ProseMirror / Quill  — expected to ACCEPT a synthetic path; a rejection is a regression.
//   Lexical              — the doc's named "strict editor" case: a clean rejection of all
//                          synthetic paths is the DOCUMENTED honest outcome, not a fail.
//
// Run: npm run test:live-gaps:editors                    (headless)
//      npm run test:live-gaps:editors -- --headed        (watch)
//      npm run test:live-gaps:editors -- lexical         (only the lexical case)
import { runCases, openReady, ensureReady, recordVia, replayVia, reaches, token, sleep, ok, bad, Skip } from "./live-helpers.mjs";

// An editor case is the same shape three times, so factor it. We overwrite the editor's
// demo content with a unique token (select-all + type), reset via reload, and assert the
// token is re-inserted by the actuator — reporting honestly (bad, not throw) when an
// editor rejects every synthetic path. NB: focus must be taken INSIDE the record window
// (via focus(), which fires no click → no stray click step) because the start-record
// round-trip blurs the page.
function editorCase(name, url, sel, { accepts = true } = {}) {
  return {
    [name]: async (ctx, sw) => {
      const { page, tabId } = await openReady(ctx, sw, url, 5000);
      let ed = page.locator(`${sel}:visible`).first();
      if (!(await ed.count())) throw new Skip(`no visible contenteditable root for ${sel}`);
      const tok = token();

      // RECORD: focus INSIDE the record window (the start-record round-trip blurs the
      // page), select-all, then type the token so it OVERWRITES the demo content — the
      // recorded value isolates to just the token, a fair test of the actuator (else a
      // huge multi-line demo+token value stresses editors' innerText normalization).
      const steps = await recordVia(sw, tabId, async () => {
        await ed.focus();
        // Double select-all: Lexical's first Cmd+A selects only the current block; the
        // second extends to the whole editor so the type overwrites everything.
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(tok, { delay: 20 });
        await sleep(200);
      });
      const editStep = steps.find((s) => s.action === "input" && s.mode === "contenteditable");
      if (!editStep) throw new Skip(`no contenteditable input step (got ${reaches(steps)})`);
      const isolated = (editStep.value || "").trim() === tok;
      (editStep.value?.includes(tok) ? ok : bad)(`captured mode=contenteditable${isolated ? " (value == token)" : " (token appended to demo)"}`, (editStep.value || "").slice(0, 30));

      // RESET: reload for a pristine, token-free editor (robust across all three).
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(5000);
      await ensureReady(sw, tabId);
      ed = page.locator(`${sel}:visible`).first();
      if ((await ed.innerText().catch(() => "")).includes(tok)) throw new Skip("token survived reload — can't isolate replay");

      // REPLAY through setEditableValue; assert both the actuator's own verdict and the
      // ground truth (token visible in innerText).
      const res = await replayVia(sw, tabId, steps);
      await sleep(300);
      const nowText = (await ed.innerText().catch(() => "")).trim();
      const landed = nowText.includes(tok);
      if (landed && res.ok) ok("replay inserted the text — actuator verified", nowText.slice(0, 40));
      else if (landed) (accepts ? bad : ok)("text present but actuator reported failure (verify too strict?)", res.results?.at(-1)?.reason);
      else if (accepts) bad("regression: editor was expected to accept a synthetic path", res.results?.at(-1)?.reason);
      else ok("confirmed honest failure — strict editor rejects all synthetic paths (documented)", res.results?.at(-1)?.reason?.slice(0, 40));
    },
  };
}

await runCases({
  ...editorCase("cat3 editor — lexical (contenteditable, beforeinput-driven)", "https://playground.lexical.dev/", '[data-lexical-editor="true"], .editor-input[contenteditable="true"]', { accepts: false }),
  ...editorCase("cat3 editor — prosemirror (contenteditable, transaction-based)", "https://prosemirror.net/examples/basic/", '.ProseMirror[contenteditable="true"]'),
  ...editorCase("cat3 editor — quill (contenteditable, Delta model)", "https://quilljs.com/", '.ql-editor'),
}, "live-gaps editors");
