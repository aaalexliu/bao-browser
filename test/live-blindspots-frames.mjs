// Bao — LIVE blindspot smoke, cross-origin frames. use-cases-and-snapshot-fallback.md §8.
//
// Asserts the all_frames content script is injected and answering INSIDE a real
// cross-origin child frame (stripe.dev embeds true cross-origin Stripe Elements iframes).
// Opt-in; a network/load failure or the frame being absent is a SKIP, not a FAIL.
//
// Run: npm run test:live:frames                (headless)
//      npm run test:live:frames -- --headed    (watch in a real window)
import { runCases, openReady, send, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "cross-origin iframe — stripe.dev (content script injected in the cross-origin child)": async (ctx, sw) => {
    const { tabId } = await openReady(ctx, sw, "https://stripe.dev/elements-examples/", 6000);
    const frames = await sw.evaluate((id) => chrome.webNavigation.getAllFrames({ tabId: id }), tabId);
    const xo = frames.find((f) => { try { return new URL(f.url).origin !== new URL(frames[0].url).origin && /stripe/.test(f.url); } catch { return false; } });
    if (!xo) throw new Skip("no cross-origin stripe frame present");
    ok("cross-origin frame present", new URL(xo.url).origin);
    let resp = null;
    try { resp = await send(sw, tabId, { cmd: "status" }, { frameId: xo.frameId }); } catch (_) {}
    (resp && "recording" in resp ? ok : bad)("all_frames content script answered INSIDE the cross-origin frame", JSON.stringify(resp));
  },
}, "live-blindspots frames");
