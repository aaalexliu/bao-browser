import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-guardrails-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  for (const file of ["eslint.config.mjs", ".dependency-cruiser.cjs", ".dependency-cruiser.runtime.cjs", "scripts/check-baselines.mjs"]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  for (const file of ["tsconfig.json", "tsconfig.desktop.json", "extension/tsconfig.json", "web/tsconfig.json"]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, types: ["node"] }, include: ["**/*.ts"] }));
  }
  return {
    write(file, text) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    },
    run(command, args, env = {}) {
      const result = spawnSync(command, args, { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
      assert.ifError(result.error);
      return { status: result.status, output: result.stdout + result.stderr };
    },
    tool(name, args) {
      return this.run(path.join(root, "node_modules/.bin", name), args);
    },
  };
}
function expect(result, status, text) {
  assert.equal(result.status, status, result.output);
  if (text) assert.match(result.output, text);
}

test("typed lint rejects a new floating promise, keeps node:test registration safe, and rejects stale suppressions", (t) => {
  const f = fixture(t);
  const file = "desktop/src/check.ts";
  f.write(file, 'import test from "node:test";\ntest("safe registration", async () => {});\nPromise.resolve("lost");\n');
  expect(f.tool("eslint", [file]), 1, /no-floating-promises/);
  expect(f.tool("eslint", [file, "--suppress-all"]), 0);
  expect(f.tool("eslint", [file]), 0);
  f.write(file, 'import test from "node:test";\ntest("safe registration", async () => {});\n');
  expect(f.tool("eslint", [file]), 2, /suppressions left/);
  expect(f.tool("eslint", [file, "--prune-suppressions"]), 0);
});

test("graph gate rejects runtime and type-only cross-product imports and runtime cycles", (t) => {
  const f = fixture(t);
  const ownership = ["desktop/src", "web/src", "--config", ".dependency-cruiser.cjs"];
  const runtime = ["desktop/src", "--config", ".dependency-cruiser.runtime.cjs"];
  f.write("web/src/shared.ts", "export const value = 1; export type Value = number;\n");
  f.write("desktop/src/check.ts", 'export { value } from "../../web/src/shared";\n');
  expect(f.tool("depcruise", ownership), 1, /no-desktop-cross-product-imports/);
  f.write("desktop/src/check.ts", 'export type { Value } from "../../web/src/shared";\n');
  expect(f.tool("depcruise", ownership), 1, /no-desktop-cross-product-imports/);
  f.write("desktop/src/check.ts", "export {};\n");
  f.write("desktop/src/app/view-types.ts", "export type View = string;\n");
  f.write("desktop/src/v1/check.ts", 'export type { View } from "../app/view-types";\n');
  expect(f.tool("depcruise", ownership), 1, /no-domain-to-views/);
  f.write("desktop/src/v1/check.ts", "export {};\n");
  f.write("desktop/src/check.ts", 'export type { Value } from "../../web/src/shared";\n');
  expect(f.tool("depcruise", [...ownership, "--baseline"]), 0);
  f.write("desktop/src/check.ts", "export {};\n");
  expect(f.tool("depcruise", [...ownership, "--ignore-known"]), 1, /stale known violations/);
  f.write("desktop/src/check.ts", 'export { b } from "./b"; export const a = 1;\n');
  f.write("desktop/src/b.ts", 'export { a } from "./check"; export const b = 2;\n');
  expect(f.tool("depcruise", runtime), 1, /no-runtime-cycles/);
  f.write("desktop/src/check.ts", 'import type { B } from "./b"; export type A = { b?: B };\n');
  f.write("desktop/src/b.ts", 'import type { A } from "./check"; export type B = { a?: A };\n');
  expect(f.tool("depcruise", runtime), 0);
});

test("graph resolves web aliases for runtime cycles and cross-product imports", (t) => {
  const f = fixture(t);
  f.write("web/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, types: [], paths: { "@/*": ["./src/*"] } },
    include: ["src"],
  }));
  const runtime = ["web/src", "--config", ".dependency-cruiser.runtime.cjs"];
  const ownership = ["web/src", "desktop/src", "--config", ".dependency-cruiser.cjs"];
  f.write("web/src/a.ts", 'import { b } from "@/b"; export const a: number = b;\n');
  f.write("web/src/b.ts", 'import { a } from "./a"; export const b: number = a;\n');
  expect(f.tool("tsc", ["-p", "web/tsconfig.json", "--noEmit"]), 0);
  expect(f.tool("depcruise", runtime), 1, /no-runtime-cycles/);
  f.write("web/src/a.ts", "export const a = 1;\n");
  expect(f.tool("depcruise", runtime), 0);
  f.write("web/src/b.ts", "export {};\n");
  f.write("desktop/src/shared.ts", "export const shared = 1;\n");
  f.write("web/src/a.ts", 'export { shared } from "../../desktop/src/shared";\n');
  expect(f.tool("depcruise", ownership), 1, /no-web-cross-product-imports/);
  f.write("web/src/a.ts", 'export { shared } from "@/../../desktop/src/shared";\n');
  expect(f.tool("tsc", ["-p", "web/tsconfig.json", "--noEmit"]), 0);
  expect(f.tool("depcruise", ownership), 1, /no-web-cross-product-imports/);
});

test("shared code stays in typed lint and both graphs without product runtime dependencies", (t) => {
  const f = fixture(t);
  const ownership = ["desktop/src", "web/src", "shared", "--config", ".dependency-cruiser.cjs"];
  const runtime = ["desktop/src", "shared", "--config", ".dependency-cruiser.runtime.cjs"];
  f.write("shared/check.ts", 'Promise.resolve("lost in shared code");\n');
  expect(f.tool("eslint", ["shared/check.ts", "--max-warnings", "0"]), 1, /no-floating-promises/);
  f.write("shared/check.ts", "export const value = 1;\n");
  f.write("desktop/src/check.ts", 'export { value } from "../../shared/check"; export type Contract = string;\n');
  f.write("web/src/check.ts", 'export { value } from "../../shared/check";\n');
  expect(f.tool("depcruise", ownership), 0);
  f.write("shared/check.ts", 'export const value = 1; export type { Contract } from "../desktop/src/check";\n');
  expect(f.tool("depcruise", ownership), 0);
  expect(f.tool("depcruise", runtime), 0);
  f.write("web/src/check.ts", 'import { value } from "../../shared/check"; export const webValue: number = value;\n');
  f.write("shared/check.ts", 'import { webValue } from "../web/src/check"; export const value: number = webValue;\n');
  expect(f.tool("tsc", ["-p", "tsconfig.desktop.json", "--noEmit"]), 0);
  expect(f.tool("depcruise", ownership), 1, /no-shared-runtime-to-products/);
  expect(f.tool("depcruise", runtime), 1, /no-runtime-cycles/);
  f.write("shared/check.ts", 'import type { Contract } from "../desktop/src/check"; export const value = 1; export type Value = Contract;\n');
  expect(f.tool("depcruise", runtime), 0);
});

test("baseline gate rejects added/increased lint suppressions and new graph edges, but accepts pruning", (t) => {
  const f = fixture(t);
  const lint = { "src/old.ts": { "@typescript-eslint/no-unsafe-assignment": { count: 2 } } };
  const edge = { type: "dependency", from: "desktop/src/old.ts", to: "web/src/old.ts", rule: { name: "no-desktop-cross-product-imports", severity: "error" } };
  f.write("src/old.ts", "export {};\n");
  f.write("eslint-suppressions.json", JSON.stringify(lint));
  f.write(".dependency-cruiser-known-violations.json", JSON.stringify([edge]));
  expect(f.run("git", ["init", "--quiet"]), 0);
  expect(f.run("git", ["add", "eslint-suppressions.json", ".dependency-cruiser-known-violations.json"]), 0);
  expect(f.run("git", ["-c", "user.name=Guardrail test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Seed baseline"]), 0);
  const check = () => f.run(process.execPath, ["scripts/check-baselines.mjs"], { BASELINE_REF: "HEAD" });
  expect(check(), 0);
  lint["src/old.ts"]["@typescript-eslint/no-unsafe-assignment"].count = 3;
  f.write("eslint-suppressions.json", JSON.stringify(lint));
  expect(check(), 1, /baseline growth.*2 -> 3/);
  lint["src/old.ts"]["@typescript-eslint/no-unsafe-assignment"].count = 1;
  f.write("src/new.ts", "export {};\n");
  f.write("eslint-suppressions.json", JSON.stringify({ ...lint, "src/new.ts": lint["src/old.ts"] }));
  expect(check(), 1, /baseline growth.*src\/new.ts/);

  f.write("eslint-suppressions.json", JSON.stringify(lint));
  expect(f.run(process.execPath, ["-e", 'require("node:fs").rmSync("src/old.ts")']), 0);
  expect(check(), 1, /unused suppression for missing file/);
  f.write("src/old.ts", "export {};\n");
  f.write(".dependency-cruiser-known-violations.json", JSON.stringify([edge, { ...edge, from: "desktop/src/new.ts" }]));
  expect(check(), 1, /baseline growth.*desktop\/src\/new.ts/);
  f.write(".dependency-cruiser-known-violations.json", "[]");
  expect(check(), 0);
  expect(f.run(process.execPath, ["scripts/check-baselines.mjs"], { BASELINE_REF: "missing-ref" }), 1, /missing-ref/);
});
