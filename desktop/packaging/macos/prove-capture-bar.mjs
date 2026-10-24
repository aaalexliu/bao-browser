// Drive the floating capture bar and write a window video.
// Frames come from the panel's own view, not a desktop capture.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = path.join(root, "desktop/packaging/macos/dist/BaoCaptureBar.app/Contents/MacOS/BaoCaptureBar");
const outDir = process.argv[2] || "/tmp/bao-capture-bar";
mkdirSync(outDir, { recursive: true });

const child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
const events = [];
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) events.push(JSON.parse(line));
    nl = buf.indexOf("\n");
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(pred, ms = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const hit = events.find(pred);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - start > ms) {
        clearInterval(timer);
        reject(new Error(`timed out after ${events.map((event) => event.event).join(",") || "no events"}`));
      }
    }, 40);
  });
}

async function shot(name) {
  const file = path.join(outDir, name);
  const before = events.length;
  send({ cmd: "shot", file });
  const event = await waitFor((item, index) => index >= before && item.event === "shot" && item.file === file);
  const size = statSync(file).size;
  if (!event.bytes || size < 1000) throw new Error(`shot ${name} was ${size} bytes`);
  return file;
}

async function press(title, text) {
  const before = events.length;
  send({ cmd: "click", title, ...(text ? { text } : {}) });
  return waitFor((item, index) => index >= before && item.event !== "shot" && item.event !== "hotkeys");
}

const frames = [];

try {
  const hotkeys = await waitFor((item) => item.event === "hotkeys");
  if (hotkeys.start !== 0 || hotkeys.stop !== 0 || hotkeys.pause !== 0) {
    throw new Error(`hotkeys ${JSON.stringify(hotkeys)}`);
  }
  const steps = ["Click Open", "Type"];
  send({ cmd: "show", paused: false, steps });
  frames.push(await shot("01-steps.png"));

  const noted = await press("Add note", "wait for the banner");
  if (noted.event !== "note" || noted.text !== "wait for the banner") throw new Error(`note event ${JSON.stringify(noted)}`);
  steps.push("Note: wait for the banner");

  const checked = await press("Add check", "Welcome");
  if (checked.event !== "check" || checked.text !== "Welcome") throw new Error(`check event ${JSON.stringify(checked)}`);
  steps.push("Check: Welcome");
  send({ cmd: "show", paused: false, steps });
  frames.push(await shot("02-note-check.png"));

  const paused = await press("Pause");
  if (paused.event !== "pause") throw new Error(`pause event ${JSON.stringify(paused)}`);
  frames.push(await shot("03-paused.png"));

  const beforeAct = events.length;
  send({ cmd: "act", title: "You need to act", body: "Press Apply on the fixture page.", badge: "!" });
  const acted = await waitFor((item, index) => index >= beforeAct && item.event === "acted");
  if (acted.badge !== "!" || acted.title !== "You need to act" || acted.notified !== true) {
    throw new Error(`act result ${JSON.stringify(acted)}`);
  }
  frames.push(await shot("04-act.png"));

  const discarded = await press("Discard");
  if (discarded.event !== "discard") throw new Error(`discard event ${JSON.stringify(discarded)}`);

  const list = frames.map((file) => `file '${file}'\nduration 1.5`).join("\n") + `\nfile '${frames[frames.length - 1]}'\n`;
  const listFile = path.join(outDir, "frames.txt");
  writeFileSync(listFile, list);
  const video = path.join(outDir, "capture-bar.mp4");
  await exec("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", video,
  ]);
  console.log(JSON.stringify({
    ok: true,
    hotkeys,
    video,
    bytes: statSync(video).size,
    notified: acted.notified,
    badge: acted.badge,
    frames,
  }));
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
}
