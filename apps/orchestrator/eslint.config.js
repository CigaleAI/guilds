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
  boundary({
    files: ["**/*.ts"],
    source: ".",
    packages: HOSTED_PACKAGES,
    repository: REPOSITORY,
  }),
);
