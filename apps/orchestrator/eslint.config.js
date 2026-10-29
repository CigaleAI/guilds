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
      "max-params": ["warn", 4],
      "@typescript-eslint/max-params": ["error", { max: 5 }],
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
    // Public functions have explicit types for inputs and outputs
    // (docs/contributing/code-guidelines.md, Types and errors).
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },
  {
    // Syntax docs/contributing/code-guidelines.md refuses.
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Types and errors.
          selector: "CatchClause[body.body.length=0]",
          message: "A catch throws a named error or returns a typed absence.",
        },
      ],
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
  {
    // A route handler reads the request, calls one domain function, and writes the reply; it does
    // not query on its own (docs/contributing/code-guidelines.md, Scaffolding). A row type is not a query.
    files: ["src/http/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../db/*", "../db/**"],
              allowTypeImports: true,
              message: "http/ calls a domain module, which reads and writes through db/.",
            },
          ],
        },
      ],
    },
  },
  {
    // A shared directory never imports from a feature (docs/contributing/code-guidelines.md, Shared
    // code): db/ imports only db/ and lib/, and lib/ only lib/.
    files: ["src/db/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ regex: "^\\.\\./(?!lib/)", message: "db/ imports only db/ and lib/." }] },
      ],
    },
  },
  {
    files: ["src/db/*/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ regex: "^\\.\\./\\.\\./(?!lib/)", message: "db/ imports only db/ and lib/." }] },
      ],
    },
  },
  {
    files: ["src/lib/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ group: ["../*"], message: "lib/ imports only lib/." }] },
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
