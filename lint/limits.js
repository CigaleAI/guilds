// The function and file limits of docs/contributing/code-guidelines.md, and the syntax it refuses,
// as an Oxlint plugin. A package's .oxlintrc.json turns the rules on for its source, tests and
// stories excepted, and records the violations that predate them in its lint-suppressions.json;
// that list only shrinks.
//
// The built-in `complexity`, `max-depth`, `max-params` and `max-lines` rules carry the limits that
// need no code; `max-lines` reports at one severity, so the hard file limit is the `file-lines`
// rule, and the blocks of nested conditional logic a function holds are the `bumpy-road` rule. The
// other rules are the syntax the guidelines refuse, each a selector over the tree.

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

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const METHODS = new Set(["MethodDefinition", "TSAbstractMethodDefinition"]);
const KEYED = new Set([...METHODS, "Property", "PropertyDefinition"]);
// The conditional and loop statements, each of which opens a level of nesting.
const NESTERS = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
]);

/** Whether a function is a closure: an arrow function or a function expression, not a method. */
function isClosure(fn) {
  return fn.type !== "FunctionDeclaration" && !METHODS.has(fn.parent?.type);
}

/**
 * The function a node counts towards: the nearest function declaration or method around it, a
 * closure counting towards the function that declares it; the outermost closure when no
 * declaration or method holds it; null outside any function.
 */
function declaringFunction(node) {
  let found = null;
  for (let current = node.parent; current; current = current.parent) {
    if (FUNCTIONS.has(current.type)) {
      if (!isClosure(current)) {
        return current;
      }
      found = current;
    }
  }
  return found;
}

/**
 * The outermost conditional or loop statement between a node and the function it counts towards,
 * closures included; null when none holds the node.
 */
function bumpRoot(node, fn) {
  let root = null;
  for (let current = node.parent; current !== fn; current = current.parent) {
    if (NESTERS.has(current.type)) {
      root = current;
    }
  }
  return root;
}

/** A function's name: its id, the const it is bound to, or its method or property key. */
function nameOf(fn) {
  const parent = fn.parent;
  if (fn.id) {
    return fn.id.name;
  }
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (KEYED.has(parent?.type) && parent.key.type === "Identifier") {
    return parent.key.name;
  }
  return "<anonymous>";
}

// A bump is a conditional or loop statement at the top level of a function's body that holds
// another; a closure's statements count towards the function that declares it. The function is
// reported at `max` bumps.
const bumpyRoad = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a function with several blocks of nested conditional logic." },
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        required: ["max"],
        additionalProperties: false,
      },
    ],
    messages: {
      bumpy:
        "`{{name}}` has {{count}} blocks of nested conditional logic; the limit is {{limit}}. Each block is a step with a contract of its own: a named function. See docs/contributing/code-guidelines.md, Functions.",
    },
  },
  create(context) {
    const { max } = context.options[0];
    const bumps = new Map();
    const record = (node) => {
      const fn = declaringFunction(node);
      const root = fn && bumpRoot(node, fn);
      if (root) {
        bumps.set(fn, (bumps.get(fn) ?? new Set()).add(root));
      }
    };
    const report = () => {
      for (const [fn, roots] of bumps) {
        if (roots.size >= max) {
          const data = { name: nameOf(fn), count: roots.size, limit: max - 1 };
          context.report({ node: fn, messageId: "bumpy", data });
        }
      }
    };
    return { ...Object.fromEntries([...NESTERS].map((type) => [type, record])), "Program:exit": report };
  },
};

export default {
  meta: { name: "limits" },
  rules: {
    "file-lines": fileLines,
    "bumpy-road": bumpyRoad,
    "silent-catch": silentCatch,
    "bare-error": bareError,
    "inline-parameter-type": inlineParameterType,
    "erased-return-type": erasedReturnType,
    "erased-alias": erasedAlias,
  },
};
