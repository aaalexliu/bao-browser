// The Mac launcher runs this and reads stdout. It does not read the server's stderr.
// Line 1 is ok or error. Line 2 is the home or the error. Each later line is a
// message the launcher shows now. It is recorded in the library, so it shows once.

const { resolveLibraryHome, showOnce } = require("./library-home.cjs");

const splits = [];
try {
  const home = resolveLibraryHome({ warn: (line, kind) => { if (kind === "split") splits.push(line); } });
  if (typeof home !== "string" || !home || home.includes("\n") || home.includes("\r")) {
    throw new Error("bao: home path contains a newline");
  }
  const lines = showOnce(home, splits);
  process.stdout.write(`ok\n${home}\n`);
  for (const line of lines) process.stdout.write(`${line}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`error\n${message.replace(/[\r\n]+/g, " ")}\n`);
  process.exit(2);
}
