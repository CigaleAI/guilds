// The function and file limits of docs/contributing/code-guidelines.md, and the syntax it refuses,
// as an Oxlint plugin. A package's .oxlintrc.json turns the rules on for its source, tests and
// stories excepted, and records the violations that predate them in its lint-suppressions.json;
// that list only shrinks.
//
// The built-in `complexity`, `max-depth`, `max-params` and `max-lines` rules carry the limits that
// need no code; `max-lines` reports at one severity, so the hard file limit is the `file-lines`
// rule. The other rules are the syntax the guidelines refuse, each a selector over the tree.

/** A rule that reports every node a selector matches. */
function refusal(description, message, ...selectors) {
  return {
    meta: {
      type: "problem",
      docs: { description },
      messages: { refused: message },
    },
    create(context) {
      const report = (node) => context.report({ node, messageId: "refused" });
      return Object.fromEntries(selectors.map((selector) => [selector, report]));
    },
  };
}

const SILENT_CATCH_MESSAGE = "A catch throws a named error or returns a typed absence.";

// A catch that neither throws nor returns; a catch whose only exit is a bare `return;`; and a
// promise's `.catch()` whose handler returns nothing, `undefined` or `null`.
const silentCatch = refusal(
  "Disallow a catch that neither throws a named error nor returns a typed absence.",
  SILENT_CATCH_MESSAGE,
  "CatchClause:not(:has(ThrowStatement, ReturnStatement))",
  "CatchClause:has(ReturnStatement):not(:has(ThrowStatement, ReturnStatement[argument]))",
  "CallExpression[callee.type='MemberExpression'][callee.property.name='catch'] > :matches(ArrowFunctionExpression[body.type='Identifier'][body.name='undefined'], ArrowFunctionExpression[body.type='Literal'][body.raw='null'], ArrowFunctionExpression[body.type='UnaryExpression'][body.operator='void'], :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement']:not(:has(ThrowStatement, ReturnStatement[argument])))",
);

const bareError = refusal(
  "Disallow a throw of a plain Error.",
  "A domain throws a named error class.",
  "ThrowStatement > NewExpression[callee.name='Error']",
);

// The outermost object type literal in a parameter's type, so one inline type is reported once.
const inlineParameterType = refusal(
  "Disallow an object type written inline in a parameter.",
  "An object parameter's type is a named type.",
  ":function > :matches(Identifier, ObjectPattern, ArrayPattern, AssignmentPattern, RestElement, TSParameterProperty) TSTypeLiteral:not(TSTypeLiteral TSTypeLiteral)",
);

// A type that names nothing, `unknown` or `Record<string, unknown>`, alone or wrapped in a promise
// or an array, as the return type of an exported function, an exported const's function, or a
// public method, and as the whole of a type alias.
const ERASED_TYPE =
  ":matches(TSUnknownKeyword, TSTypeReference[typeName.name='Record'][typeArguments.params.0.type='TSStringKeyword'][typeArguments.params.1.type='TSUnknownKeyword'])";
const erasedAt = (position) =>
  `:matches(${position}, ${position} > TSArrayType, ${position} > TSTypeReference[typeName.name=/^(Promise|Array)$/] > TSTypeParameterInstantiation) > ${ERASED_TYPE}`;
const RETURN_TYPE =
  ":matches(:matches(ExportNamedDeclaration, ExportDefaultDeclaration) > FunctionDeclaration, ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression), ExportDefaultDeclaration > :matches(ArrowFunctionExpression, FunctionExpression), :matches(MethodDefinition, TSAbstractMethodDefinition):not([accessibility='private'], [accessibility='protected'], [key.type='PrivateIdentifier']) > :matches(FunctionExpression, TSEmptyBodyFunctionExpression)) > TSTypeAnnotation";

const erasedReturnType = refusal(
  "Disallow an export whose return type is unknown or Record<string, unknown>.",
  "An export returns a named type.",
  erasedAt(RETURN_TYPE),
);

const erasedAlias = refusal(
  "Disallow a type alias that is only unknown or Record<string, unknown>.",
  "A named type names a shape.",
  erasedAt("TSTypeAliasDeclaration"),
);

const fileLines = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a file longer than the hard limit." },
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

export default {
  meta: { name: "limits" },
  rules: {
    "file-lines": fileLines,
    "silent-catch": silentCatch,
    "bare-error": bareError,
    "inline-parameter-type": inlineParameterType,
    "erased-return-type": erasedReturnType,
    "erased-alias": erasedAlias,
  },
};
