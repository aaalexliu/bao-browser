import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**", "**/dist/**", "**/out/**", "**/.next/**",
    ".git/**", ".toolchain/**", ".cursor/**", "web/next-env.d.ts",
  ]),
  {
    files: ["{desktop/src,desktop/test,extension/src,src,web/src}/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.desktop.json", "extension/tsconfig.json", "web/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{
          from: "package", package: "node:test", name: ["test", "it", "describe", "suite"],
        }],
      }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": true, "ts-expect-error": true, "ts-nocheck": true, "ts-check": false,
      }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-debugger": "error",
      "no-unreachable": "error",
      "no-unsafe-optional-chaining": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-loss-of-precision": "error",
    },
  },
]);
