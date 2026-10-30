import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundary } from "../../eslint.boundary.js";
import { limits } from "../../eslint.limits.js";

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
  limits({ files: ["src/**/*.ts", "src/**/*.tsx"] }),
  {
    // A shared directory never imports from a feature (docs/contributing/code-guidelines.md, Shared
    // code): api/ and app/ import nothing under features/. The router is the composition root that
    // mounts the features, and the exception.
    files: ["src/api/**", "src/app/**"],
    ignores: ["src/app/router.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(\\.\\./)+features(/|$)",
              message: "A shared directory never imports from a feature.",
            },
          ],
        },
      ],
    },
  },
  boundary({
    files: ["**/*.{ts,tsx}"],
    source: ".",
    packages: HOSTED_PACKAGES,
    repository: REPOSITORY,
  }),
);
