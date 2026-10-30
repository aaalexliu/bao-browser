// Render the Chrome Web Store small promo tile (440x280) from the bao mark.
// Reuses the already-installed Playwright Chromium (no new deps). Output -> assets/store/.
//   node assets/gen-promo.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../assets/store");
mkdirSync(OUT, { recursive: true });

// Just the steamed-bao bun (the "bun only" variant from assets/icon.svg, no squircle
// ground) on a transparent field, so the tile's own orange gradient shows through behind
// it. Kept in sync with the finalized icon: dough gradient, pleat cap, content ^^ face.
const mark = `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">
    <defs>
      <radialGradient id="dough" cx="42%" cy="32%" r="78%">
        <stop offset="0" stop-color="#FFFDF8"/><stop offset="0.66" stop-color="#FFF1DE"/>
        <stop offset="1" stop-color="#F8DEBE"/>
      </radialGradient>
    </defs>
    <g stroke="#FFE6C4" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.75">
      <path d="M41 27 C39.2 24.3 42.8 23 41 20.3"/>
      <path d="M50 26 C48.2 23.3 51.8 22 50 19.3"/>
      <path d="M59 27 C57.2 24.3 60.8 23 59 20.3"/>
    </g>
    <path d="M50 34 C70 34 79 48 79 62 C79 78 65 84 50 84 C35 84 21 78 21 62 C21 48 30 34 50 34Z"
          fill="url(#dough)" stroke="#EBD3B2" stroke-width="1.4"/>
    <ellipse cx="50" cy="36.5" rx="6.5" ry="3.9" fill="#FCEED8" stroke="#EBD3B2" stroke-width="1"/>
    <path d="M36 60 Q41 52.5 46 60" stroke="#3A302A" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M54 60 Q59 52.5 64 60" stroke="#3A302A" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M44 72 Q50 77 56 72" stroke="#3A302A" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  </svg>`;

const html = `<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:440px;height:280px;overflow:hidden}
  .tile{width:440px;height:280px;position:relative;
    background:linear-gradient(155deg,#F59A4B 0%,#D2661D 100%);
    display:flex;align-items:center;gap:22px;padding:0 40px;
    font-family:-apple-system,system-ui,"Segoe UI",sans-serif}
  .tile::before{content:"";position:absolute;inset:0;
    background:radial-gradient(120% 100% at 30% 12%,rgba(255,255,255,.28),transparent 55%)}
  .mark{width:150px;height:150px;flex:0 0 auto;position:relative;
    filter:drop-shadow(0 8px 18px rgba(0,0,0,.22))}
  .copy{position:relative;color:#fff}
  .name{font-size:56px;font-weight:800;letter-spacing:-1px;line-height:1}
  .tag{margin-top:12px;font-size:19px;font-weight:500;line-height:1.3;
    color:rgba(255,255,255,.9);max-width:180px}
</style>
<div class="tile">
  <div class="mark">${mark}</div>
  <div class="copy">
    <div class="name">Bao</div>
    <div class="tag">Record &amp; replay browser actions</div>
  </div>
</div>`;

const page = await (await chromium.launch()).newPage({ deviceScaleFactor: 2 });
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(html, { waitUntil: "networkidle" });
writeFileSync(resolve(OUT, "promo-440x280.png"), await page.locator(".tile").screenshot());
console.log("  wrote assets/store/promo-440x280.png (rendered @2x, resize to 440x280 to submit)");
await page.context().browser().close();
