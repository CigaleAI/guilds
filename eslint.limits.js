// The function and file limits of docs/contributing/code-guidelines.md, and the syntax it refuses,
// for every package's source, tests and stories excepted. Existing violations are listed in the
// package's eslint-suppressions.json; that list only shrinks.
//
// A file is warned past 800 lines and refused past 1,000 (`max-lines` reports at one severity, so
// the hard limit is a rule of its own).

const IGNORES = ["**/*.test.ts", "**/*.test.tsx", "**/*.stories.tsx", "test/**", "scripts/**"];

// Syntax docs/contributing/code-guidelines.md refuses, under Types and errors and under Functions.
const SILENT_CATCH = {
  selector: "CatchClause:not(:has(ThrowStatement, ReturnStatement))",
  message: "A catch throws a named error or returns a typed absence.",
};
const BARE_ERROR = {
  selector: "ThrowStatement > NewExpression[callee.name='Error']",
  message: "A domain throws a named error class.",
};
// The outermost object type literal in a parameter's type, so one inline type is reported once.
const INLINE_PARAMETER_TYPE = {
  selector:
    ":function > :matches(Identifier, ObjectPattern, ArrayPattern, AssignmentPattern, RestElement, TSParameterProperty) TSTypeLiteral:not(TSTypeLiteral TSTypeLiteral)",
  message: "An object parameter's type is a named type.",
};

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

/**
 * The flat-config blocks that hold `files` to the limits. `commands` are the command-line modules
 * among them: a command is no domain, and its Error reaches the person who ran it rather than an
 * HTTP mapping, so it may throw a plain Error.
 */
export function limits({ files, commands = [] }) {
  const forCommands = {
    files: commands,
    ignores: IGNORES,
    rules: { "no-restricted-syntax": ["error", SILENT_CATCH, INLINE_PARAMETER_TYPE] },
  };
  return [
    {
      files,
      ignores: IGNORES,
      plugins: { limits: { rules: { "file-lines": fileLines } } },
      rules: {
        complexity: ["error", 11],
        "max-depth": ["error", 3],
        "max-params": ["error", 4],
        "max-lines": ["warn", { max: 800, skipBlankLines: false, skipComments: false }],
        "limits/file-lines": ["error", { max: 1000 }],
        "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
        "no-restricted-syntax": ["error", SILENT_CATCH, BARE_ERROR, INLINE_PARAMETER_TYPE],
      },
    },
    ...(commands.length === 0 ? [] : [forCommands]),
  ];
}
