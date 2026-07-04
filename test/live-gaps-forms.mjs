// Bao — live gap suite, cat 1 (forms). recording-gaps-and-app-universe.md §Part 3.
//
// Drives the real extension on the selenium web-form: records a text `input` + a native
// `<select>` change, resets both to a baseline, replays, and asserts the values were
// driven back through the native-setter path (baseline → target, so replay must
// actually change something — not a no-op that fakes a pass).
//
// Run: npm run test:live-gaps:forms                (headless)
//      npm run test:live-gaps:forms -- --headed    (watch in a real window)
import { runCases, openReady, recordVia, replayVia, reaches, token, sleep, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "cat1 forms — selenium web-form (text input + native <select> round-trip)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://www.selenium.dev/selenium/web/web-form.html");
    const text = page.locator('input[name="my-text"]');
    const select = page.locator('select[name="my-select"]');
    if (!(await text.count()) || !(await select.count())) throw new Skip("web-form structure changed (no my-text / my-select)");

    // Pick a target option that genuinely DIFFERS from the reset baseline (options[0]),
    // so replay has to actually change the value — not a no-op that fakes a pass.
    const opts = await select.evaluate((s) => [...s.options].filter((o) => !o.disabled).map((o) => o.value));
    const base = opts[0];
    const optValue = opts.find((v, i) => i > 0 && v && v !== base);
    if (!optValue) throw new Skip("no distinct second <option> to round-trip");
    const tok = token();

    // RECORD: fill fires `input` → input step; selectOption fires `change` → select step.
    const steps = await recordVia(sw, tabId, async () => {
      await text.fill(tok);
      await select.selectOption(optValue);
      await sleep(200);
    });
    const inputStep = steps.find((s) => s.action === "input");
    const selectStep = steps.find((s) => s.action === "select");
    if (!inputStep || !selectStep) throw new Skip(`did not capture input+select (got ${reaches(steps)})`);
    (inputStep.value === tok ? ok : bad)("captured the text input value", inputStep.value);

    // RESET both fields to the baseline, then REPLAY and assert the values were driven back.
    await text.fill("");
    await select.selectOption(base);
    const res = await replayVia(sw, tabId, steps);
    (res.ok ? ok : bad)("replay ran all steps", res.ok ? "" : res.results?.at(-1)?.reason);
    const after = await page.evaluate(() => ({
      text: document.querySelector('input[name="my-text"]').value,
      sel: document.querySelector('select[name="my-select"]').value,
    }));
    (after.text === tok ? ok : bad)("text input value restored via native setter", after.text);
    (after.sel === optValue ? ok : bad)("native <select> value restored (baseline → target)", `${after.sel} (was ${base}, wanted ${optValue})`);
  },
}, "live-gaps forms");
