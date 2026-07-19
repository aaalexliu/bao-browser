// esbuild: bundle each extension entry point into a standalone IIFE in dist/.
// Content scripts can't use ES modules, so everything (shared types + helpers)
// is inlined per bundle. Run: npm run build   (watch: npm run build -- --watch)
import { build, context } from "esbuild";

const options = {
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/sidepanel.ts",
    "src/dashboard.ts",
    "src/forceopen.ts",
  ],
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "es2022",
  sourcemap: false,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
