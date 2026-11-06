const { spawn } = require("node:child_process");

const child = spawn("/Applications/Bao.app/Contents/MacOS/bao-mcp", [], {
  stdio: "inherit",
  env: { ...process.env, BAO_NODE: process.execPath },
});
child.on("error", () => {
  process.stderr.write("Cannot start Bao. Install Bao.app.\n");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
