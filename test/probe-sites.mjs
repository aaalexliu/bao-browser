// Bao — generic bot-accessibility prober for candidate live test targets.
//
// Loads each URL headless with a realistic UA (no extension, no login) and reports:
//   - accessibility verdict: OK | BLOCKED (challenge/login wall) | DEAD (4xx/5xx/DNS)
//   - the structural signals the recording test cases key on: forms/inputs/selects,
//     contenteditable editors, canvas, cross-origin iframes, open shadow roots,
//     role=row density (virtualization tell), SPA hint, DOM size.
//
// This is how the target tables in recording-gaps-and-app-universe.md §Part 3 and
// use-cases-and-snapshot-fallback.md §8 get (re)verified: live sites rot, so re-run
// this before trusting a table that's more than a month old.
//
// Run: npm run probe                      (the built-in registry)
//      npm run probe -- feed              (only categories/urls matching "feed")
//      npm run probe -- https://foo.bar   (ad-hoc URLs work too)
//      npm run probe -- --json            (raw JSON lines, for piping)
//      npm run probe -- --headed          (watch)
import { chromium } from "playwright";

// The registry: category → verified-or-candidate live targets. Keep in sync with the
// per-category test-case table in recording-gaps-and-app-universe.md.
const REGISTRY = [
  // cat 1 — form/CRUD
  ["forms", "https://www.selenium.dev/selenium/web/web-form.html"],
  ["forms", "https://the-internet.herokuapp.com/"],
  ["forms", "https://httpbin.org/forms/post"],
  ["forms", "https://demoqa.com/automation-practice-form"],
  // cat 2 — rich SPA / custom widgets / dnd
  ["spa", "https://bsky.app/"],
  ["spa", "https://todomvc.com/examples/react/dist/"],
  ["spa", "https://www.saucedemo.com/"],
  ["widgets", "https://mui.com/material-ui/react-select/"],
  ["widgets", "https://www.radix-ui.com/primitives/docs/components/select"],
  ["dnd", "https://react-dnd.github.io/react-dnd/examples"],
  ["dnd", "https://atlassian.design/components/pragmatic-drag-and-drop/examples"],
  // cat 3 — editors / calendar
  ["editor", "https://playground.lexical.dev/"],
  ["editor", "https://prosemirror.net/examples/basic/"],
  ["editor", "https://quilljs.com/playground/snow"],
  ["calendar", "https://fullcalendar.io/demos"],
  // cat 4 — feeds
  ["feed", "https://news.ycombinator.com/"],
  ["feed", "https://bsky.app/profile/bsky.app"],
  ["feed", "https://mastodon.social/explore"],
  // cat 5 — canvas
  ["canvas", "https://excalidraw.com/"],
  ["canvas", "https://www.tldraw.com/"],
  ["canvas", "https://wonderous.app/web/"],
  // cat 6 — grids
  ["grid", "https://www.ag-grid.com/example/"],
  ["grid", "https://handsontable.com/demo"],
  // cat 7 — checkout / identity walls
  ["checkout", "https://checkout.stripe.dev/"],
  ["checkout", "https://stripe.dev/elements-examples/"],
  ["checkout", "https://www.google.com/recaptcha/api2/demo"],
  ["checkout", "https://accounts.hcaptcha.com/demo"],
  // cat 8 — anti-bot (a challenge here is the SIGNAL, not a failure)
  ["antibot", "https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/"],
  ["antibot", "https://nowsecure.nl/"],
];

const argv = process.argv.slice(2);
const HEADED = argv.includes("--headed") || argv.includes("-H");
const JSON_OUT = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("-"));
const adhoc = positional.filter((a) => /^https?:\/\//.test(a));
const filter = positional.find((a) => !/^https?:\/\//.test(a))?.toLowerCase();

const targets = adhoc.length
  ? adhoc.map((u) => ["adhoc", u])
  : REGISTRY.filter(([cat, url]) => !filter || cat.includes(filter) || url.toLowerCase().includes(filter));

// Signals evaluated inside the page. Heuristics, not proofs — a human (or the live
// smoke suite) confirms the interesting ones.
function collectSignals() {
  const txt = (document.body?.innerText || "").slice(0, 3000);
  const challenge = /just a moment|verify you are human|attention required|checking your browser|are you a robot|access denied|unusual traffic/i
    .test(txt + " " + document.title);
  // Login wall ≈ a lone password form with almost no other fields on an
  // otherwise empty page (a page merely CONTAINING a password field isn't one).
  const loginWall = !challenge && !!document.querySelector('input[type="password"]') &&
    document.querySelectorAll("form").length <= 1 &&
    document.querySelectorAll("input,textarea").length <= 4 && txt.length < 600;
  let openShadow = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { openShadow++; if (openShadow < 500) walk(el.shadowRoot); }
    }
  };
  try { walk(document); } catch (_) {}
  const xoIframes = Array.from(document.querySelectorAll("iframe")).filter((f) => {
    try { return f.src && new URL(f.src, location.href).origin !== location.origin; } catch { return false; }
  }).length;
  return {
    title: document.title.slice(0, 60),
    challenge, loginWall,
    forms: document.querySelectorAll("form").length,
    inputs: document.querySelectorAll("input,textarea").length,
    selects: document.querySelectorAll("select").length,
    editable: document.querySelectorAll('[contenteditable="true"],[contenteditable=""]').length,
    canvas: document.querySelectorAll("canvas").length,
    xoIframes,
    openShadow,
    rows: document.querySelectorAll('[role="row"]').length,
    domNodes: document.querySelectorAll("*").length,
    spa: !!document.querySelector("#root,#app,[data-reactroot]"),
  };
}

function verdictOf(row) {
  if (row.error) return "DEAD";
  if (row.challenge) return "BLOCKED(challenge)";
  if (row.status >= 400) return `DEAD(${row.status})`;
  if (row.loginWall) return "LOGIN-WALL?";
  return "OK";
}

const browser = await chromium.launch({ channel: "chromium", headless: !HEADED });
const ctx = await browser.newContext({
  // Same realistic UA as live-blindspots.mjs — without it CloudFront/Akamai-fronted
  // sites bot-block outright (the anti-bot blind spot, live).
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 900 },
});

let blocked = 0, dead = 0;
for (const [cat, url] of targets) {
  const page = await ctx.newPage();
  const row = { cat, url };
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(4500); // hydration: shadow roots / iframes / canvas / grids
    row.status = resp ? resp.status() : 0;
    row.finalUrl = page.url();
    Object.assign(row, await page.evaluate(collectSignals));
  } catch (e) {
    row.error = String(e.message || e).split("\n")[0].slice(0, 90);
  }
  row.verdict = verdictOf(row);
  if (row.verdict.startsWith("BLOCKED")) blocked++;
  if (row.verdict.startsWith("DEAD")) dead++;
  if (JSON_OUT) console.log(JSON.stringify(row));
  else {
    const sig = row.error ? row.error : [
      row.forms && `forms:${row.forms}`, row.inputs && `inputs:${row.inputs}`,
      row.selects && `selects:${row.selects}`, row.editable && `editable:${row.editable}`,
      row.canvas && `canvas:${row.canvas}`, row.xoIframes && `xo-iframes:${row.xoIframes}`,
      row.openShadow && `open-shadow:${row.openShadow}`, row.rows && `rows:${row.rows}`,
      row.spa && "spa",
    ].filter(Boolean).join(" ");
    console.log(`${row.verdict.padEnd(18)} [${cat}] ${url}\n${"".padEnd(19)}${sig || "(no signals)"}`);
  }
  await page.close();
}
await browser.close();
console.log(`\nprobed ${targets.length}: ${targets.length - blocked - dead} ok, ${blocked} blocked, ${dead} dead`);
