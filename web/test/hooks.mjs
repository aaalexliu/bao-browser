import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (context.format === "json") {
    const json = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default JSON.parse(${JSON.stringify(json)});`, shortCircuit: true };
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !pathHasExtension(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

function pathHasExtension(specifier) {
  return /\.[A-Za-z0-9]+$/.test(specifier);
}
