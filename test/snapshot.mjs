// T13 regression: Tier-2 capture-only DOM subtree snapshot.
// Each step carries target.snapshot — outerHTML of the anchor node (or a ~3-hop
// ancestor when unanchored), with value attributes stripped and capped at 64KB. It's
// offline anchor-re-derivation fuel; never read at replay. Three cases:
//   1) anchored click in a repeated feed → snapshot is that card's subtree
//   2) a declared password value="…" never appears in any snapshot
//   3) an oversized subtree is truncated with a marker
//
// Run: npm run test:snapshot   (or: node test/snapshot.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-snapshot.html")).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function sendToContent(sw, tabId, msg) {
  return sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
}

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });

    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    await sendToContent(sw, tabId, { cmd: "start-record" });
    // 1) Like on the SECOND card (identical buttons → anchors to the card).
    await page.locator("li.card", { hasText: "Post 102" }).getByText("Like").click();
    // 2) Click the login button (its 3-hop ancestor is #loginbox, which holds the pw).
    await page.click("#login");
    // 3) Click grow (its 3-hop ancestor #huge exceeds the cap).
    await page.click("#grow");
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    check("3 steps recorded", steps?.length === 3, JSON.stringify(steps?.map((s) => s.action)));
    check("every step carries a snapshot", (steps || []).every((s) => typeof s.target?.snapshot === "string"),
      JSON.stringify(steps?.map((s) => typeof s.target?.snapshot)));

    // 1) Anchored card snapshot contains that card's content, not the whole feed.
    const like = steps[0];
    check("like step anchored to a card", !!like?.target?.anchor, JSON.stringify(like?.target?.anchor));
    check("card snapshot contains the anchored post", (like?.target?.snapshot || "").includes("Post 102"),
      (like?.target?.snapshot || "").slice(0, 120));
    check("card snapshot is scoped (excludes sibling cards)",
      !(like?.target?.snapshot || "").includes("Post 101") && !(like?.target?.snapshot || "").includes("Post 103"));

    // 2) The declared password value is stripped from EVERY snapshot.
    const leak = (steps || []).find((s) => (s.target?.snapshot || "").includes("hunter2"));
    check("no snapshot leaks the password value attribute", !leak,
      leak ? (leak.target.snapshot.match(/.{0,20}hunter2.{0,20}/) || [""])[0] : "none");
    const login = steps[1];
    check("login snapshot DID include the password field (masked)",
      (login?.target?.snapshot || "").includes('type="password"'));
    check("login snapshot shows the value emptied", /value=""/.test(login?.target?.snapshot || ""),
      (login?.target?.snapshot || "").match(/<input[^>]*>/)?.[0]);

    // 3) Oversized subtree truncated with the marker, at/under the cap (+marker).
    const grow = steps[2];
    const snap = grow?.target?.snapshot || "";
    check("oversized snapshot carries the truncation marker", /bao:truncated \d+B/.test(snap),
      snap.slice(-40));
    check("truncated snapshot is capped near 64KB", snap.length <= 64 * 1024 + 64, `${snap.length}B`);
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("\n✗ harness error:", e);
    process.exit(1);
  });
