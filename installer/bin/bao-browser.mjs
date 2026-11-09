#!/usr/bin/env node
// The bao-browser installer: download the prebuilt Bao.app this package pins, check its size and SHA-256,
// put it in /Applications (or ~/Applications), link ~/.local/bin/bao, then run the app's own
// `bao setup` so the owner picks which agents start Bao. No build tools, no certificate.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
/** The command that runs this installer. bao-browser is not on npm, so it runs the copy attached to the latest release. */
const NPX = "npx https://github.com/aaalexliu/bao-browser/releases/latest/download/bao-browser.tgz";
const USAGE = `usage: ${NPX} [--dir DIR] [--yes | --agents a,b | --none] [--release FILE_OR_URL]
       ${NPX} setup|doctor [args]   run the installed Bao's own setup or doctor

With no command, download Bao.app ${PKG.version}, check it, place it, then pick agents.

--dir     the Applications folder to use (default: /Applications, else ~/Applications)
--yes     set up every agent found on this Mac without asking
--agents  set up these agents: claude-code, codex, claude-desktop, cursor
--none    install the app and set up no agent
--release a release.json (path or URL) instead of the one in this package`;

const bold = (text) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text);
const dim = (text) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text);
const step = (text) => process.stdout.write(`${bold("›")} ${text}\n`);

class InstallError extends Error {}

function home() {
  return process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : homedir();
}

function parse(argv) {
  const out = { command: "install", dir: "", setup: [], yes: false, release: "", rest: [] };
  if (argv[0] && !argv[0].startsWith("-")) {
    if (argv[0] !== "setup" && argv[0] !== "doctor") throw new InstallError(`unknown command: ${argv[0]}`);
    out.command = argv[0];
    out.rest = argv.slice(1);
    return out;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new InstallError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--dir") out.dir = path.resolve(value());
    else if (arg === "--release") out.release = value();
    else if (arg === "--yes" || arg === "--none") {
      out.setup.push(arg);
      if (arg !== "--none") out.yes = true;
    }
    else if (arg === "--agents") out.setup.push("--agents", value());
    else if (arg === "--help" || arg === "-h") out.command = "help";
    else throw new InstallError(`unknown argument: ${arg}`);
  }
  return out;
}

/** darwin-arm64 on an Apple silicon Mac, even when this Node runs under Rosetta. */
function platformKey() {
  if (process.platform !== "darwin") throw new InstallError(`Bao runs on macOS only. This is ${process.platform}.`);
  const translated = spawnSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).stdout?.trim() === "1";
  if (!translated && process.arch !== "arm64") throw new InstallError("Bao needs an Apple silicon Mac for now.");
  return "darwin-arm64";
}

/** A path or URL as a URL, so a release.json can name its zip relative to itself. */
function asUrl(source) {
  return /^(https?|file):\/\//.test(source) ? new URL(source) : pathToFileURL(path.resolve(source));
}

async function readRelease(source) {
  const url = asUrl(source);
  let text;
  if (url.protocol === "file:") {
    try {
      text = readFileSync(fileURLToPath(url), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new InstallError(`${fileURLToPath(url)} is missing. This copy of bao-browser names no release; pass --release with a release.json.`);
      throw err;
    }
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new InstallError(`${url}: HTTP ${res.status}`);
    text = await res.text();
  }
  const release = JSON.parse(text);
  if (!release.version || !release.platforms) throw new InstallError(`${source} is not a Bao release.json`);
  return { release, base: url };
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function progress(label, total) {
  let done = 0;
  let last = 0;
  return (bytes) => {
    done += bytes;
    const now = Date.now();
    if (!process.stdout.isTTY || (now - last < 100 && done < total)) return;
    last = now;
    const pct = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    process.stdout.write(`\r  ${label} ${String(pct).padStart(3)}% ${dim(`${(done / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`)}`);
    if (done >= total) process.stdout.write("\n");
  };
}

/** The release zip in ~/Library/Caches/bao, downloaded once and checked every time. */
async function download(asset, version, key, base) {
  const cache = path.join(home(), "Library", "Caches", "bao", "downloads");
  mkdirSync(cache, { recursive: true });
  const file = path.join(cache, `Bao-${version}-${key}.zip`);
  if (existsSync(file) && statSync(file).size === asset.size && (await sha256(file)) === asset.sha256) {
    step(`Using the copy downloaded earlier ${dim(file)}`);
    return keepOnly(file);
  }
  const part = `${file}.part`;
  const tick = progress("Bao.app", asset.size);
  const counter = async function* (source) {
    for await (const chunk of source) {
      tick(chunk.length);
      yield chunk;
    }
  };
  const url = new URL(asset.url, base);
  if (url.protocol === "file:") {
    await pipeline(createReadStream(fileURLToPath(url)), counter, createWriteStream(part));
  } else {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new InstallError(`${url}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(part));
  }
  const size = statSync(part).size;
  const digest = await sha256(part);
  if (size !== asset.size || digest !== asset.sha256) {
    rmSync(part, { force: true });
    throw new InstallError(`The download does not match this release (size ${size}, sha256 ${digest}). Nothing was installed.`);
  }
  renameSync(part, file);
  return keepOnly(file);
}

/** Removes every other Bao download, and any partial one, from the cache folder, so it holds one release. */
function keepOnly(file) {
  const dir = path.dirname(file);
  for (const name of readdirSync(dir)) {
    if (name !== path.basename(file) && /^Bao-.+\.zip(\.part)?$/.test(name)) rmSync(path.join(dir, name), { force: true });
  }
  return file;
}

function applicationsDir(chosen) {
  if (chosen) {
    mkdirSync(chosen, { recursive: true });
    return chosen;
  }
  try {
    accessSync("/Applications", constants.W_OK);
    return "/Applications";
  } catch {
    const mine = path.join(home(), "Applications");
    mkdirSync(mine, { recursive: true });
    return mine;
  }
}

/** The codesign that reads signatures. Tests point BAO_INSTALLER_CODESIGN at a stand-in to play a certificate-signed app. */
const CODESIGN = process.env.BAO_INSTALLER_CODESIGN || "/usr/bin/codesign";

function signature(app) {
  const details = spawnSync(CODESIGN, ["-dvv", app], { encoding: "utf8" }).stderr || "";
  if (/Signature=adhoc/.test(details)) return "ad-hoc";
  return /^Authority=(.+)$/m.exec(details)?.[1] || "unsigned";
}

/** The designated requirement macOS keys a helper grant to: the helper's when the app carries one, else the app's. */
function requirement(app) {
  const helper = path.join(app, "Contents", "Resources", "BaoOSHelper.app");
  const result = spawnSync(CODESIGN, ["-d", "-r-", existsSync(helper) ? helper : app], { encoding: "utf8" });
  return /designated => (.*)$/m.exec(`${result.stdout || ""}${result.stderr || ""}`)?.[1]?.trim() || "";
}

function signerOf(app) {
  const verify = spawnSync(CODESIGN, ["--verify", "--strict", app], { encoding: "utf8" });
  if (verify.status !== 0) throw new InstallError(`Bao.app failed codesign --verify: ${verify.stderr.trim()}. Nothing was installed.`);
  return signature(app);
}

/** The processes that run from this app, Bao and the bao-mcp servers agents start. Replacing it then would pull files from under them. */
function running(app) {
  const result = spawnSync("/usr/bin/pgrep", ["-lf", `${app}/Contents/`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** True when the owner says to replace a certificate-signed app with one signed another way. Keep is the default. */
async function replaceSigned(target, old, signer, yes) {
  const how = signer === "ad-hoc" ? "signed ad-hoc" : `signed by ${signer} with a different certificate`;
  const loss = `${target} is signed by ${old}. This release is ${how}, so replacing it drops the helper's Accessibility grant, which Running Chrome, the native Mac app driver, and bao remote-debugging use, and Bao's Files & Folders > Google Chrome switch.${signer === "ad-hoc" ? " Agents then answer to macOS as their own app again." : ""}`;
  if (!yes && process.stdin.isTTY && process.stdout.isTTY) {
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise((resolve) => {
        ask.once("close", () => resolve(""));
        ask.question(`${loss} Replace it? [y/N] `).then(resolve, () => resolve(""));
      });
      if (/^y(es)?$/i.test(answer.trim())) return true;
    } finally {
      ask.close();
    }
  } else process.stdout.write(`${loss}\n`);
  process.stdout.write(`Kept ${target}. Nothing was installed. To replace it: quit Bao, remove ${target}, then run ${NPX} again.\n`);
  return false;
}

async function place(zip, dir, yes) {
  const target = path.join(dir, "Bao.app");
  const busy = existsSync(target) ? running(target) : "";
  if (busy) {
    throw new InstallError(`These processes run from ${target}:\n${busy.replace(/^/gm, "  ")}\nQuit Bao and every agent app or session that uses it (Claude Desktop, Cursor, Claude Code, Codex), then run this again.`);
  }
  const stage = mkdtempSync(path.join(dir, ".bao-install-"));
  try {
    const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zip, stage], { encoding: "utf8" });
    if (unzip.status !== 0) throw new InstallError(`ditto could not unpack ${zip}: ${unzip.stderr.trim()}`);
    const staged = path.join(stage, "Bao.app");
    if (!existsSync(staged)) throw new InstallError(`${zip} has no Bao.app`);
    const signer = signerOf(staged);
    if (existsSync(target)) {
      const old = signature(target);
      const certified = old !== "ad-hoc" && old !== "unsigned";
      if (certified && requirement(staged) !== requirement(target) && !(await replaceSigned(target, old, signer, yes))) return null;
      renameSync(target, path.join(stage, "previous-Bao.app"));
    }
    renameSync(staged, target);
    return { app: target, signer };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** A path as one shell word, so a printed command runs when pasted. */
function shellWord(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * ~/.local/bin/bao -> Bao.app/Contents/MacOS/bao-cli. A file there that is not Bao's link stays.
 * bao is the full path that runs this app. offPath is true when the link is made but ~/.local/bin is not on PATH.
 */
function link(app) {
  const bin = path.join(home(), ".local", "bin");
  const file = path.join(bin, "bao");
  const target = path.join(app, "Contents", "MacOS", "bao-cli");
  if (!existsSync(target)) return { note: `${target} is missing, so no bao command was linked`, bao: "", offPath: false };
  const unlinked = { bao: shellWord(target), offPath: false };
  mkdirSync(bin, { recursive: true });
  try {
    const stat = lstatSync(file);
    if (!stat.isSymbolicLink() || !/Bao\.app\/Contents\/MacOS\/bao-cli$/.test(readlinkSync(file))) return { note: `${file} exists and is not Bao's, so it was left alone`, ...unlinked };
    unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  symlinkSync(target, file);
  return { note: `linked ${file}`, bao: shellWord(file), offPath: !(process.env.PATH || "").split(":").includes(bin) };
}

function runApp(app, args) {
  const cli = path.join(app, "Contents", "MacOS", "bao-cli");
  if (!existsSync(cli)) throw new InstallError(`${cli} is missing. Install Bao first: ${NPX}`);
  const result = spawnSync(cli, args, { stdio: "inherit" });
  return result.status ?? 1;
}

function installedApp() {
  return ["/Applications/Bao.app", path.join(home(), "Applications", "Bao.app")].find((app) => existsSync(app));
}

async function install(opts) {
  const started = Date.now();
  const key = platformKey();
  const { release, base } = await readRelease(opts.release || path.join(HERE, "..", "release.json"));
  const asset = release.platforms[key];
  if (!asset) throw new InstallError(`Bao ${release.version} has no build for ${key}. It has ${Object.keys(release.platforms).join(", ")}.`);
  process.stdout.write(`${bold(`Bao ${release.version}`)} ${dim(`for ${key}, ${(asset.size / 1e6).toFixed(0)} MB`)}\n`);
  const zip = await download(asset, release.version, key, base);
  step(`Checked size and SHA-256 ${dim(asset.sha256.slice(0, 16))}`);
  const dir = applicationsDir(opts.dir);
  const placed = await place(zip, dir, opts.yes);
  if (!placed) return 0;
  const { app, signer } = placed;
  step(`Installed ${app} ${dim(`(signed: ${signer})`)}`);
  const linked = link(app);
  step(linked.note);
  step(`Took ${((Date.now() - started) / 1000).toFixed(1)} s. Now pick the agents that should use Bao.\n`);
  const status = runApp(app, ["setup", "--app", app, ...opts.setup]);
  if (linked.bao) process.stdout.write(`\n${dim(`Check this install any time: ${linked.bao} doctor   ·   change agents: ${linked.bao} setup`)}\n`);
  if (linked.offPath) process.stdout.write(`${dim("To run plain bao, add ~/.local/bin to your PATH.")}\n`);
  return status;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.command === "setup" || opts.command === "doctor") {
    const named = opts.rest.indexOf("--app");
    const app = named >= 0 && opts.rest[named + 1] ? path.resolve(opts.rest[named + 1]) : installedApp();
    if (!app) throw new InstallError(`Bao is not installed. Run: ${NPX}`);
    return runApp(app, [opts.command, ...opts.rest]);
  }
  return install(opts);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`bao-browser: ${err instanceof InstallError ? err.message : err.stack || err}\n`);
    process.exit(1);
  },
);
