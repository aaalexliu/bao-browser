// Bundle the extension and wrap the existing page recorder. No second recorder.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    background: path.join(here, "src/background.ts"),
    content: path.join(here, "src/content.ts"),
    popup: path.join(here, "src/popup.ts"),
    allow: path.join(here, "src/allow.ts"),
  },
  bundle: true,
  outdir: dist,
  format: "iife",
  target: ["chrome120"],
  platform: "browser",
  logLevel: "info",
});

await build({
  entryPoints: [path.join(here, "src/recorder-wrap.ts")],
  bundle: true,
  outfile: path.join(dist, "recorder-gen.cjs"),
  format: "cjs",
  platform: "node",
  logLevel: "silent",
});

const { writeRecorder } = await import(path.join(dist, "recorder-gen.cjs"));
writeRecorder(path.join(dist, "recorder.js"));
copyFileSync(path.join(here, "manifest.json"), path.join(dist, "manifest.json"));
copyFileSync(path.join(here, "src/popup.html"), path.join(dist, "popup.html"));
copyFileSync(path.join(here, "src/allow.html"), path.join(dist, "allow.html"));
copyFileSync(path.join(here, "src/dialogs.js"), path.join(dist, "dialogs.js"));

const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
if (manifest.content_scripts || (manifest.host_permissions || []).length) {
  throw new Error("the extension must not ship content scripts or install-time host permissions");
}
writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
