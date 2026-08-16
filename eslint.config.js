import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  // I6c: tests/** are linted with the same recommendedTypeChecked baseline as
  // src/**, parsed via tsconfig.test.json. Plan §H predicted ~25+ softenings
  // were needed for mock idioms; the actual probe surfaced 11 issues, all
  // resolved by tightening the test code rather than weakening rules. Keep
  // this block minimal — only set the parser project + the same noise
  // controls applied to src/**. Anything beyond that should be a targeted
  // override with a comment that names the line(s) that motivated it.
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
      },
    },
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
);
