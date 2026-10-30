import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";
import globals from "globals";
import tseslint from "typescript-eslint";
import { limits } from "../../eslint.limits.js";

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
);
