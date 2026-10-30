export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !pathHasExtension(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

function pathHasExtension(specifier) {
  return /\.[A-Za-z0-9]+$/.test(specifier);
}
