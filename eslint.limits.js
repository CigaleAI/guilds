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
// A catch whose only exit is a bare `return;`, and a promise's `.catch()` whose handler returns
// nothing, `undefined` or `null`, are the same silent catch.
const SILENT_RETURN_CATCH = {
  selector: "CatchClause:has(ReturnStatement):not(:has(ThrowStatement, ReturnStatement[argument]))",
  message: SILENT_CATCH.message,
};
const SILENT_PROMISE_CATCH = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > :matches(ArrowFunctionExpression[body.type='Identifier'][body.name='undefined'], ArrowFunctionExpression[body.type='Literal'][body.raw='null'], ArrowFunctionExpression[body.type='UnaryExpression'][body.operator='void'], :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement']:not(:has(ThrowStatement, ReturnStatement[argument])))",
  message: SILENT_CATCH.message,
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
// A type that names nothing, `unknown` or `Record<string, unknown>`, alone or wrapped in a promise
// or an array, as the return type of an exported function, an exported const's function, or a
// public method, and as the whole of a type alias.
const ERASED_TYPE =
  ":matches(TSUnknownKeyword, TSTypeReference[typeName.name='Record'][typeArguments.params.0.type='TSStringKeyword'][typeArguments.params.1.type='TSUnknownKeyword'])";
const erasedAt = (position) =>
  `:matches(${position}, ${position} > TSArrayType, ${position} > TSTypeReference[typeName.name=/^(Promise|Array)$/] > TSTypeParameterInstantiation) > ${ERASED_TYPE}`;
const RETURN_TYPE =
  ":matches(:matches(ExportNamedDeclaration, ExportDefaultDeclaration) > FunctionDeclaration, ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression), ExportDefaultDeclaration > :matches(ArrowFunctionExpression, FunctionExpression), :matches(MethodDefinition, TSAbstractMethodDefinition):not([accessibility='private'], [accessibility='protected'], [key.type='PrivateIdentifier']) > :matches(FunctionExpression, TSEmptyBodyFunctionExpression)) > TSTypeAnnotation";
const ERASED_RETURN_TYPE = {
  selector: erasedAt(RETURN_TYPE),
  message: "An export returns a named type.",
};
const ERASED_ALIAS = {
  selector: erasedAt("TSTypeAliasDeclaration"),
  message: "A named type names a shape.",
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
    rules: {
      "no-restricted-syntax": [
        "error",
        SILENT_CATCH,
        SILENT_RETURN_CATCH,
        SILENT_PROMISE_CATCH,
        INLINE_PARAMETER_TYPE,
        ERASED_RETURN_TYPE,
        ERASED_ALIAS,
      ],
    },
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
        "no-restricted-syntax": [
          "error",
          SILENT_CATCH,
          SILENT_RETURN_CATCH,
          SILENT_PROMISE_CATCH,
          BARE_ERROR,
          INLINE_PARAMETER_TYPE,
          ERASED_RETURN_TYPE,
          ERASED_ALIAS,
        ],
      },
    },
    ...(commands.length === 0 ? [] : [forCommands]),
  ];
}
