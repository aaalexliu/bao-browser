const { options } = require("./.dependency-cruiser.cjs");

module.exports = {
  forbidden: [{
    name: "no-runtime-cycles",
    severity: "error",
    from: {},
    to: { circular: true },
  }],
  options: { ...options, tsPreCompilationDeps: false },
};
