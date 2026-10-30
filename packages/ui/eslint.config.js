import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundary } from "../../eslint.boundary.js";
import { limits } from "../../eslint.limits.js";

// The repository this package's relative imports must stay inside
// (docs/architecture/extension-points.md). It names no hosted package: none depends on it.
const REPOSITORY = "../..";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  ...storybook.configs["flat/recommended"],
  {
    ignores: ["storybook-static/**", "node_modules/**"],
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
  boundary({
    files: ["**/*.{ts,tsx}"],
    source: ".",
    repository: REPOSITORY,
  }),
);
