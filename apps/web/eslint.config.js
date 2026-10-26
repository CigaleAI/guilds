import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundary } from "../../eslint.boundary.js";

// The hosted packages, which nothing in this package may import, and the repository its relative
// imports must stay inside (docs/architecture/extension-points.md).
const HOSTED_PACKAGES = ["@guildsrun/hosted-web", "@guildsrun/hosted-server"];
const REPOSITORY = "../..";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    ignores: ["node_modules/**", "claude-design-export/**"],
  },
  {
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The function and file limits of docs/contributing/code-guidelines.md. Existing violations
    // are listed in eslint-suppressions.json; that list only shrinks.
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      complexity: ["error", 11],
      "max-depth": ["error", 3],
      "max-params": ["warn", 4],
      "@typescript-eslint/max-params": ["error", { max: 5 }],
      "max-lines": ["error", { max: 800, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    // A cast creates no knowledge (docs/contributing/code-guidelines.md, Types and errors).
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  },
  boundary({
    files: ["**/*.{ts,tsx}"],
    source: ".",
    packages: HOSTED_PACKAGES,
    repository: REPOSITORY,
  }),
);
