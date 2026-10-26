import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { boundary } from "../../eslint.boundary.js";

// The hosted packages, which nothing in this package may import, and the repository its relative
// imports must stay inside (docs/architecture/extension-points.md).
const HOSTED_PACKAGES = ["@guildsrun/hosted-server"];
const REPOSITORY = "../..";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
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
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      complexity: ["error", 11],
      "max-depth": ["error", 3],
      "max-params": ["error", 4],
      "max-lines": ["error", { max: 800, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    // A cast creates no knowledge (docs/contributing/code-guidelines.md, Types and errors).
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  },
  {
    // A domain module imports nothing from the HTTP framework (docs/contributing/code-guidelines.md,
    // Boundaries). The roots, the extension points and the observability hooks are the exceptions.
    files: ["src/**/*.ts"],
    ignores: [
      "src/http/**",
      "src/app.ts",
      "src/compose.ts",
      "src/extension.ts",
      "src/observability/**",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "fastify", message: "Only http/ and the roots import fastify." }] },
      ],
    },
  },
  boundary({
    files: ["**/*.ts"],
    source: ".",
    packages: HOSTED_PACKAGES,
    repository: REPOSITORY,
  }),
);
