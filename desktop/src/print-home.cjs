// The Mac launcher runs this and reads stdout. It does not read the server's stderr.

const { resolveLibraryHome } = require("./library-home.cjs");

const notices = [];
try {
  const home = resolveLibraryHome({ warn: (line) => notices.push(line) });
  if (typeof home !== "string" || !home || home.includes("\n") || home.includes("\r")) {
    throw new Error("bao: home path contains a newline");
  }
  process.stdout.write(`ok\n${home}\n`);
  for (const line of notices) process.stdout.write(`${line}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`error\n${message.replace(/[\r\n]+/g, " ")}\n`);
  process.exit(2);
}
