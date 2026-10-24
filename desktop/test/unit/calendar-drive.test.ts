// A covered react-big-calendar day cell used to hang capture drive.
// Playwright retries locator.click while the Selected bar owns the center.
// The drive click has to return, the cell has to receive the pointer,
// and Reserve Now stays unclicked.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";

process.env.BAO_DRIVE = "1";
process.env.BAO_CHROME_NO_SANDBOX = "1";

test("capture drive clicks a covered calendar day and does not reserve", { timeout: 120000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cal-"));
  const app = await startApp({ home, port: 0 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture/calendar` }),
    });
    assert.equal(opened.ok, true, await opened.text());
    const started = Date.now();
    const drive = await fetch(`${base}/api/sessions/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ click: "#covered-day", timeout: 4000 }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await drive.text();
    assert.equal(drive.ok, true, body);
    assert.ok(Date.now() - started < 5000, `drive took ${Date.now() - started}ms`);
    const view = await (await fetch(`${base}/api/sessions/page`)).json() as { text?: string };
    const text = view.text || "";
    assert.match(text, /day received/);
    assert.match(text, /stay open/);
    assert.equal(text.includes("booked"), false);
  } finally {
    await fetch(`http://127.0.0.1:${app.port}/api/sessions/discard`, { method: "POST" }).catch(() => undefined);
    await app.close();
  }
});
