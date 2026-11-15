// Rasterize assets/icon.svg into Bao.app's icon, desktop/packaging/macos/AppIcon.icns.
// The tile sits on Apple's macOS icon grid: an 824 px rounded square with a soft shadow on a
// 1024 px canvas. Uses the already-installed Playwright Chromium and macOS iconutil.
//   node assets/gen-mac-icon.mjs
import { testChromium as chromium } from "../desktop/src/test-browser.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "desktop", "packaging", "macos", "AppIcon.icns");
// Apple's grid at 1024: the tile is 824 wide, starts 100 in, and its corner radius is 185.4.
const TILE = 824 / 1024;
const RADIUS = 185.4 / 824;
// iconutil names: icon_<points>x<points>[@2x].png
const ENTRIES = [16, 32, 128, 256, 512].flatMap((points) => [
  { name: `icon_${points}x${points}.png`, px: points },
  { name: `icon_${points}x${points}@2x.png`, px: points * 2 },
]);

// Crop the viewBox to the tile so the svg box is the tile, and match the corner to Apple's.
const svg = readFileSync(resolve(HERE, "icon.svg"), "utf8")
  .replace('viewBox="0 0 100 100"', 'viewBox="4 4 92 92"')
  .replace('rx="24"', `rx="${(92 * RADIUS).toFixed(2)}"`);

const iconset = join(mkdtempSync(join(tmpdir(), "bao-icon-")), "AppIcon.iconset");
mkdirSync(iconset);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { name, px } of ENTRIES) {
    const tile = px * TILE;
    const inset = (px - tile) / 2;
    // Apple's template shadow at 1024: 12 px down, 28 px blur, 30% black. Tiny sizes skip it.
    const unit = px / 1024;
    const shadow = px >= 64 ? `filter:drop-shadow(0 ${12 * unit}px ${14 * unit}px rgba(0,0,0,.3));` : "";
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(
      `<style>*{margin:0;padding:0}html,body{background:transparent;width:${px}px;height:${px}px}
       svg{position:absolute;left:${inset}px;top:${inset}px;width:${tile}px;height:${tile}px;${shadow}}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
    writeFileSync(join(iconset, name), png);
  }
} finally {
  await browser.close();
}
const made = spawnSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", OUT], { encoding: "utf8" });
rmSync(dirname(iconset), { recursive: true, force: true });
if (made.status !== 0) throw new Error(`iconutil failed: ${made.stderr}`);
console.log(`wrote ${OUT}`);
