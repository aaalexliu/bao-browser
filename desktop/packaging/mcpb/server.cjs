const { spawn } = require("node:child_process");
const path = require("node:path");

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("Bao needs Node.js 24 or newer. Update Claude Desktop or use Bao Settings to add its launcher directly.\n");
  process.exit(1);
}

const app = process.argv[2];
if (!app || !path.isAbsolute(app) || !app.endsWith(".app")) {
  process.stderr.write("Choose the installed Bao.app directory in this extension's settings.\n");
  process.exit(1);
}

const child = spawn(path.join(app, "Contents", "MacOS", "bao-mcp"), [], {
  stdio: "inherit",
  env: { ...process.env, BAO_NODE: process.execPath },
});
child.on("error", () => {
  process.stderr.write("Cannot start Bao. Install Bao.app, then choose its directory in this extension's settings.\n");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
