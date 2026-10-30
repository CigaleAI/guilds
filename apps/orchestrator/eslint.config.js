import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { boundary } from "../../eslint.boundary.js";
import { limits } from "../../eslint.limits.js";

// The hosted packages, which nothing in this package may import, and the repository its relative
// imports must stay inside (docs/architecture/extension-points.md).
const HOSTED_PACKAGES = ["@guildsrun/hosted-server"];
const REPOSITORY = "../..";
// The re-export modules a tool requires: drizzle-kit reads the schema mirror from its index
// (drizzle.config.ts).
const INDEXES = ["src/db/schema/index.ts"];

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
  limits({ files: ["src/**/*.ts"], commands: ["src/cli/**/*.ts"] }),
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
    indexes: INDEXES,
  }),
);
