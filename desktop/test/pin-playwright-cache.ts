import { pinPlaywrightBrowsers } from "../src/playwright-cache.js";

// runtime.ts imports this before launch.ts, which loads Playwright.
pinPlaywrightBrowsers(process.env);
