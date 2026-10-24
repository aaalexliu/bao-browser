// Capture 7 + 5 on the GTK calculator by resolving each button, then replay
// {{a}} + {{b}} on a window that was launched at a different size.
// The shell wrapper owns Xvfb. This file skips without BAO_CALC=1.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fromAtspiNode } from "../../src/v1/identity";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { AtspiDriver } from "../../src/v1/os-driver";
import { osNodes } from "../../src/proxy/os";
import { replay } from "../../src/v1/replay";
import { unavailableHeal } from "../../src/v1/heal";

const bin = process.env.BAO_OS_HELPER || "";
const screen = process.env.BAO_SCREEN || "1400x900";

test("calculator capture replays with two number pairs", { skip: process.env.BAO_CALC !== "1" }, async () => {
  const raw = await osNodes(bin, screen);
  const events: TrailEvent[] = [];
  for (const name of ["7", "+", "5", "="]) {
    const node = raw.find((item) => item.name === name && /button/i.test(item.role));
    assert.ok(node, name);
    const x = Math.round(node.bbox.x + node.bbox.w / 2);
    const y = Math.round(node.bbox.y + node.bbox.h / 2);
    const click = spawnSync("xdotool", ["mousemove", String(x), String(y), "click", "1"], { env: process.env });
    assert.equal(click.status, 0, click.stderr?.toString());
    events.push({
      id: `c-${events.length}`,
      ts: events.length + 1,
      kind: "act",
      op: "osClick",
      identity: fromAtspiNode(node),
      provenance: { x, y, space: "screen" },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const after = await new AtspiDriver(bin, screen).tree();
  assert.ok(after.texts.includes("12"), after.texts.join(","));
  const workflow = interpret(events, { id: "wf-calc", name: "Calculator", startUrl: "desktop://baocalc" });
  if (process.env.BAO_WRITE_EXAMPLES === "1") {
    writeFileSync("examples/workflows/calculator.json", JSON.stringify(workflow, null, 2));
  }
  assert.equal(workflow.inputs.map((input) => input.type).join(","), "number,number");
  for (const [a, b, expect, x, y] of [[7, 7, "14", 80, 60], [5, 7, "12", 240, 180]] as const) {
    await relaunch(x, y, a === 7 && b === 7 ? 300 : 480, a === 7 && b === 7 ? 200 : 300);
    const run = await replay(workflow, { a, b }, new AtspiDriver(bin, screen), { heal: unavailableHeal() });
    assert.equal(run.status, "passed", JSON.stringify(run.failure));
    const shown = await new AtspiDriver(bin, screen).tree();
    assert.ok(shown.texts.includes(expect), shown.texts.join(","));
  }
});

function relaunch(x: number, y: number, w: number, h: number): Promise<void> {
  const py = process.env.BAO_CALC_PY || "desktop/os-helper/baocalc.py";
  return new Promise((resolve, reject) => {
    spawn("pkill", ["-f", "baocalc.py"]).on("close", () => {
      const child = spawn("python3", [py, "--x", String(x), "--y", String(y), "--w", String(w), "--h", String(h)], {
        stdio: "ignore",
        env: process.env,
        detached: true,
      });
      child.unref();
      child.on("error", reject);
      setTimeout(resolve, 700);
    });
  });
}
