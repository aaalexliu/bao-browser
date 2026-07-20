// Rasterize assets/icon.svg to PNG app icons at the sizes Chrome + the CWS need.
// Uses the already-installed Playwright Chromium (no new deps). Output -> icons/.
//   node assets/gen-icons.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "icons");
const SIZES = [16, 32, 48, 128];        // manifest icons
const svg = readFileSync(resolve(__dirname, "icon.svg"), "utf8");

mkdirSync(OUT, { recursive: true });

const page = await (await chromium.launch()).newPage({ deviceScaleFactor: 1 });

for (const s of SIZES) {
  await page.setViewportSize({ width: s, height: s });
  // Transparent background so the rounded tile's corners stay clean on any surface.
  await page.setContent(
    `<style>*{margin:0;padding:0}html,body{background:transparent}
     svg{display:block;width:${s}px;height:${s}px}</style>${svg}`,
    { waitUntil: "networkidle" }
  );
  const buf = await page.locator("svg").screenshot({ omitBackground: true });
  writeFileSync(resolve(OUT, `icon-${s}.png`), buf);
  console.log(`  wrote icons/icon-${s}.png`);
}

// A 440x280 contact sheet so the design can be eyeballed at every size at once.
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(
  `<style>*{margin:0;padding:0;box-sizing:border-box}
   body{background:#fff;font:12px system-ui;display:flex;gap:28px;align-items:flex-end;
        justify-content:center;height:280px}
   .c{display:flex;flex-direction:column;align-items:center;gap:8px;color:#666}
   .p{background:#f2f2f2;border-radius:6px;padding:6px}</style>
   ${SIZES.map(s=>`<div class="c"><div class="p"><img width="${s}" height="${s}"
      src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}"></div>${s}px</div>`).join("")}`,
  { waitUntil: "networkidle" }
);
writeFileSync(resolve(OUT, "preview.png"), await page.screenshot());
console.log("  wrote icons/preview.png");

await page.context().browser().close();
