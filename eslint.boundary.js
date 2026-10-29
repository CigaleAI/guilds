// The core/hosted boundary as a lint rule (docs/architecture/extension-points.md): core code may not import
// hosted code. A core package names the hosted packages, the repository its relative imports must
// stay inside, the hosted paths still inside it, and the core files that still cross the boundary;
// that last list only shrinks, and an entry a file no longer needs is an error.
//
// The same block fails a module made only of re-exports (docs/contributing/code-guidelines.md,
// Boundaries). A core package names the indexes a tool requires, which are the exceptions.
import path from "node:path";

const EXTENSION = /\.(js|ts|tsx)$/;

function underSource(sourceRoot, file) {
  const relative = path.relative(sourceRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** The hosted package a specifier names, whether the package itself or a module inside it. */
function hostedPackage(packages, specifier) {
  return packages.find((name) => specifier === name || specifier.startsWith(`${name}/`)) ?? null;
}

/** The hosted path a file sits in: a directory entry ends with `/`, a file entry names one module. */
function hostedPath(hosted, relative) {
  const bare = relative.replace(EXTENSION, "");
  return (
    hosted.find((entry) =>
      entry.endsWith("/") ? relative.startsWith(entry) : entry.replace(EXTENSION, "") === bare,
    ) ?? null
  );
}

const noHostedImports = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          source: { type: "string" },
          hosted: { type: "array", items: { type: "string" } },
          packages: { type: "array", items: { type: "string" } },
          repository: { type: "string" },
          leaks: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
        },
        required: ["source", "hosted", "leaks"],
        additionalProperties: false,
      },
    ],
    messages: {
      hosted: "Core may not import hosted code ({{path}}). See docs/architecture/extension-points.md.",
      outside: "Core may not import code outside its repository ({{path}}). See docs/architecture/extension-points.md.",
      stale: "This file no longer imports {{path}}: remove it from the boundary's leaks.",
    },
  },
  create(context) {
    const { source, hosted, leaks, packages = [], repository } = context.options[0];
    const sourceRoot = path.resolve(context.cwd, source);
    const repositoryRoot = repository === undefined ? null : path.resolve(context.cwd, repository);
    const file = underSource(sourceRoot, context.filename);
    if (file === null || hostedPath(hosted, file) !== null) {
      return {};
    }
    const allowed = leaks[file] ?? [];
    const used = new Set();

    function check(node) {
      const specifier = node.source?.value;
      if (typeof specifier !== "string") {
        return;
      }
      if (!specifier.startsWith(".")) {
        const name = hostedPackage(packages, specifier);
        if (name !== null) {
          context.report({ node: node.source, messageId: "hosted", data: { path: name } });
        }
        return;
      }
      const resolved = path.resolve(path.dirname(context.filename), specifier);
      if (repositoryRoot !== null && underSource(repositoryRoot, resolved) === null) {
        context.report({ node: node.source, messageId: "outside", data: { path: specifier } });
        return;
      }
      const target = underSource(sourceRoot, resolved);
      const entry = target === null ? null : hostedPath(hosted, target);
      if (entry === null) {
        return;
      }
      if (allowed.includes(entry)) {
        used.add(entry);
        return;
      }
      context.report({ node: node.source, messageId: "hosted", data: { path: entry } });
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      "Program:exit"(node) {
        for (const entry of allowed) {
          if (!used.has(entry)) {
            context.report({ node, messageId: "stale", data: { path: entry } });
          }
        }
      },
    };
  },
};

/** A statement that hands on another module's exports: `export * from` or `export { x } from`. */
function isReexport(statement) {
  return (
    (statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") &&
    statement.source !== null
  );
}

const noReexportModules = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          source: { type: "string" },
          indexes: { type: "array", items: { type: "string" } },
        },
        required: ["source", "indexes"],
        additionalProperties: false,
      },
    ],
    messages: {
      reexport:
        "A module that only re-exports others does not exist. See docs/contributing/code-guidelines.md, Boundaries.",
    },
  },
  create(context) {
    const { source, indexes } = context.options[0];
    const file = underSource(path.resolve(context.cwd, source), context.filename);
    if (file === null || indexes.includes(file)) {
      return {};
    }
    return {
      Program(node) {
        if (node.body.length > 0 && node.body.every(isReexport)) {
          context.report({ node, messageId: "reexport" });
        }
      },
    };
  },
};

/** A flat-config block that holds `files` to the boundary. */
export function boundary({
  files,
  source,
  hosted = [],
  leaks = {},
  packages = [],
  repository,
  indexes = [],
}) {
  return {
    files,
    plugins: {
      boundary: {
        rules: { "no-hosted-imports": noHostedImports, "no-reexport-modules": noReexportModules },
      },
    },
    rules: {
      "boundary/no-hosted-imports": ["error", { source, hosted, leaks, packages, repository }],
      "boundary/no-reexport-modules": ["error", { source, indexes }],
    },
  };
}
