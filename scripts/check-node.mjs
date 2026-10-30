import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = Number(readFileSync(path.join(root, ".nvmrc"), "utf8").trim());
const got = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(want) || got < want) {
  console.error(`Node ${process.version} is older than .nvmrc (${want}).`);
  console.error("Run nvm use. If node -v is still older, prepend the bin directory from nvm which node.");
  console.error('export PATH="$(dirname "$(nvm which node)"):$PATH"');
  process.exit(1);
}
console.log(process.version);
