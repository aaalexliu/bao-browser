import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pin = JSON.parse(await readFile(new URL("./agent-browser-pin.json", import.meta.url), "utf8"));
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("usage: node stage-agent-browser.mjs <absolute destination>");
const platform = `${process.platform}-${process.arch}`;
if (!pin.binaries[platform]) throw new Error(`agent-browser is not pinned for ${platform}`);
const scratch = await mkdtemp(path.join(tmpdir(), "bao-engine-stage-"));
const sha = (data) => createHash("sha256").update(data).digest("hex");
try {
  const bytes = process.env.BAO_AGENT_BROWSER_ARCHIVE
    ? await readFile(process.env.BAO_AGENT_BROWSER_ARCHIVE)
    : Buffer.from(await (await fetch(pin.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  if (sha(bytes) !== pin.archiveSha256) throw new Error("agent-browser archive checksum mismatch");
  const archive = path.join(scratch, "release.tgz");
  await writeFile(archive, bytes);
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", scratch]);
  const pkg = path.join(scratch, "package");
  const binary = path.join(pkg, "bin", `agent-browser-${platform}`);
  if (sha(await readFile(binary)) !== pin.binaries[platform]) throw new Error("agent-browser binary checksum mismatch");
  await mkdir(destination, { recursive: true });
  await cp(binary, path.join(destination, "agent-browser"));
  await chmod(path.join(destination, "agent-browser"), 0o755);
  await cp(path.join(pkg, "skill-data"), path.join(destination, "skill-data"), { recursive: true });
  await cp(path.join(pkg, "LICENSE"), path.join(destination, "LICENSE"));
  await cp(path.join(pkg, "package.json"), path.join(destination, "upstream-package.json"));
  await cp(fileURLToPath(new URL("./agent-browser-pin.json", import.meta.url)), path.join(destination, "pin.json"));
  console.log(`STAGED agent-browser ${pin.version} ${platform} sha256=${pin.binaries[platform]}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
