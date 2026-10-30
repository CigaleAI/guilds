// The function and file limits of docs/contributing/code-guidelines.md as one flat-config block,
// for every package's source, tests and stories excepted. Existing violations are listed in the
// package's eslint-suppressions.json; that list only shrinks.
//
// A file is warned past 800 lines and refused past 1,000 (`max-lines` reports at one severity, so
// the hard limit is a rule of its own).

const fileLines = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer" } },
        required: ["max"],
        additionalProperties: false,
      },
    ],
    messages: {
      long: "A file of {{lines}} lines holds more than one concern: split it by sub-domain. See docs/contributing/code-guidelines.md, Scaffolding.",
    },
  },
  create(context) {
    const { max } = context.options[0];
    return {
      Program(node) {
        const lines = context.sourceCode.lines.length;
        if (lines > max) {
          context.report({ node, messageId: "long", data: { lines } });
        }
      },
    };
  },
};

/** A flat-config block that holds `files` to the limits. */
export function limits({ files }) {
  return {
    files,
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"],
    plugins: { limits: { rules: { "file-lines": fileLines } } },
    rules: {
      complexity: ["error", 11],
      "max-depth": ["error", 3],
      "max-params": ["error", 4],
      "max-lines": ["warn", { max: 800, skipBlankLines: false, skipComments: false }],
      "limits/file-lines": ["error", { max: 1000 }],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
  };
}
