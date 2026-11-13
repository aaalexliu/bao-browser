import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileArgs, fileOperands, hidePaths } from "../../src/engines/agent-browser-files";

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), "bao-files-"));
  return { root, downloads: path.join(root, "downloads", "run-1"), done: () => rm(root, { recursive: true, force: true }) };
}

test("a download lands in the run's downloads folder under the agent's file name, wherever the global flags sit", async () => {
  const { downloads, done } = await scratch();
  try {
    for (const args of [["@e5", "statement.pdf"], ["--json", "@e5", "statement.pdf"], ["@e5", "--max-output", "100", "statement.pdf"]]) {
      const files = await fileArgs("download", args, downloads);
      const at = args.indexOf("statement.pdf");
      const saved = path.join(downloads, "statement.pdf");
      assert.deepEqual(files.forwarded, args.map((arg, i) => i === at ? saved : arg));
      assert.deepEqual(files.recorded, args);
      assert.equal(files.saved, saved);
    }
    assert.ok((await stat(downloads)).isDirectory(), "Bao creates the folder before the native download writes into it");
  } finally { await done(); }
});

test("a download whose name is taken gets the next free numbered name", async () => {
  const { downloads, done } = await scratch();
  try {
    await mkdir(downloads, { recursive: true });
    await writeFile(path.join(downloads, "statement.pdf"), "first");
    const second = await fileArgs("download", ["@e5", "statement.pdf"], downloads);
    assert.equal(second.saved, path.join(downloads, "statement (2).pdf"));
    assert.deepEqual(second.recorded, ["@e5", "statement (2).pdf"]);
    await writeFile(second.saved!, "second");
    assert.equal((await fileArgs("download", ["@e5", "statement.pdf"], downloads)).saved, path.join(downloads, "statement (3).pdf"));
  } finally { await done(); }
});

test("a download refuses a path or a missing name before anything runs", async () => {
  const { downloads, done } = await scratch();
  try {
    for (const name of ["../escape.pdf", "/tmp/statement.pdf", "sub/statement.pdf", "~/statement.pdf", ".", "..", ""]) {
      await assert.rejects(fileArgs("download", ["@e5", name], downloads), /plain file name/, name);
    }
    await assert.rejects(fileArgs("download", ["@e5"], downloads), /a selector and one file name/);
    await assert.rejects(fileArgs("download", ["@e5", "a.pdf", "b.pdf"], downloads), /a selector and one file name/);
  } finally { await done(); }
});

test("an upload takes absolute paths, ~/ paths, and names of files this run downloaded", async () => {
  const { root, downloads, done } = await scratch();
  try {
    await mkdir(downloads, { recursive: true });
    await writeFile(path.join(downloads, "statement.pdf"), "pdf");
    const absolute = path.join(root, "w2.pdf");
    const files = await fileArgs("upload", ["input[type=file]", absolute, "~/Documents/1099.pdf", "statement.pdf"], downloads);
    assert.deepEqual(files.forwarded, ["input[type=file]", absolute, path.join(homedir(), "Documents", "1099.pdf"), path.join(downloads, "statement.pdf")]);
    assert.deepEqual(files.recorded, ["input[type=file]", "w2.pdf", "1099.pdf", "statement.pdf"]);
    assert.equal(files.saved, undefined);
  } finally { await done(); }
});

test("an upload refuses a relative path, a name this run did not download, and no file at all", async () => {
  const { downloads, done } = await scratch();
  try {
    for (const word of ["./statement.pdf", "docs/statement.pdf", ".."]) {
      await assert.rejects(fileArgs("upload", ["#f", word], downloads), /absolute path, a ~\/ path, or the name of a file this run downloaded, not/, word);
    }
    await assert.rejects(fileArgs("upload", ["#f", "never.pdf"], downloads), /downloaded no file named never\.pdf/);
    await assert.rejects(fileArgs("upload", ["#f"], downloads), /at least one file/);
  } finally { await done(); }
});

test("hidden paths become file names in every spelling: the agent's, the absolute one, and the one with links resolved", async () => {
  const { root, downloads, done } = await scratch();
  try {
    await mkdir(path.join(root, "real"), { recursive: true });
    await symlink(path.join(root, "real"), path.join(root, "link"));
    await writeFile(path.join(root, "real", "w2.pdf"), "pdf");
    const upload = await fileArgs("upload", ["#f", path.join(root, "link", "w2.pdf")], downloads);
    const real = await realpath(path.join(root, "real", "w2.pdf"));
    assert.equal(hidePaths(`set ${path.join(root, "link", "w2.pdf")} and ${real}`, upload.hide), "set w2.pdf and w2.pdf");
    const home = await fileArgs("upload", ["#f", "~/Documents/1099.pdf"], downloads);
    assert.equal(hidePaths("no file at ~/Documents/1099.pdf", home.hide), "no file at 1099.pdf");
    assert.equal(hidePaths(`no file at ${path.join(homedir(), "Documents", "1099.pdf")}`, home.hide), "no file at 1099.pdf");

    const download = await fileArgs("download", ["@e5", "statement.pdf"], downloads);
    const nativeSpelling = path.join(await realpath(downloads), "statement.pdf");
    assert.equal(hidePaths(`✓ Download saved to ${nativeSpelling}\n`, download.hide), "✓ Download saved to statement.pdf\n");
    assert.equal(hidePaths(`timed out in ${downloads}`, download.hide), "timed out in run-1");
  } finally { await done(); }
});

test("file operands skip global flags and their values", () => {
  assert.deepEqual(fileOperands(["--json", "#f", "--max-output", "9", "a.pdf", "b.pdf"]), { selector: "#f", files: ["a.pdf", "b.pdf"] });
  assert.deepEqual(fileOperands([]), { files: [] });
});
