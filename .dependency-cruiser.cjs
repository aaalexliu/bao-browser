const products = {
  desktop: "desktop/src/",
  extension: "extension/src/",
  legacy: "src/",
  web: "web/src/",
};

module.exports = {
  forbidden: [
    ...Object.entries(products).map(([owner, root]) => ({
      name: `no-${owner}-cross-product-imports`,
      severity: "error",
      comment: "Products may share contracts, but must not import each other's implementation.",
      from: { path: `^${root}` },
      to: { path: `^(?:${Object.values(products).filter((other) => other !== root).join("|")})` },
    })),
    {
      name: "no-domain-to-views",
      severity: "error",
      from: { path: "^desktop/src/v1/" },
      to: { path: "^desktop/src/app/(views|view-types)\\.ts$" },
    },
    {
      name: "no-runtime-to-dev-tools",
      severity: "error",
      from: { path: "^desktop/src/", pathNot: "^desktop/src/(eval|proof)/" },
      to: { path: "^desktop/src/(eval|proof)/" },
    },
  ],
  options: {
    includeOnly: "^(desktop/src|extension/src|src|web/src)/",
    exclude: "\\.test\\.tsx?$",
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.desktop.json" },
    tsPreCompilationDeps: true,
    baseline: { staleEntriesSeverity: "error" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
