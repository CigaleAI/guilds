#!/usr/bin/env node
// Lints a package with Oxlint and subtracts the errors that predate the rules, recorded in the
// package's lint-suppressions.json as `{ "<file>": { "<rule>": { "count": n } } }`. An error the
// file does not cover fails; so does an entry the code no longer needs, because the list only
// shrinks. Warnings are printed and do not fail.
//
//   node scripts/lint.mjs <oxlint paths...>            lint, from the package's directory
//   node scripts/lint.mjs --write <oxlint paths...>    lint and rewrite lint-suppressions.json
//
// scripts/check-suppressions.sh keeps a commit from adding entries unless it is a rule commit.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SUPPRESSIONS = "lint-suppressions.json";

/** The path of the Oxlint binary this script's workspace installs. */
function oxlintBinary() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("oxlint/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin.oxlint);
}

/** Oxlint's diagnostics for the paths, as its JSON formatter prints them. */
function lint(paths) {
  const result = spawnSync(oxlintBinary(), ["-f", "json", ...paths], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.stderr.trim()) {
    process.stderr.write(result.stderr);
  }
  const start = result.stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`oxlint printed no JSON (exit ${result.status}): ${result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout.slice(start)).diagnostics;
}

/** The rule a diagnostic code names: `complexity` for ESLint's rules, `plugin/rule` otherwise. */
function ruleName(code) {
  const match = /^(\w[\w-]*)\((.+)\)$/.exec(code);
  if (match === null) {
    return code;
  }
  return match[1] === "eslint" ? match[2] : `${match[1]}/${match[2]}`;
}

/** The errors counted per file and rule, in the suppressions file's shape, sorted for a diff. */
function tally(errors) {
  const counts = {};
  for (const error of errors) {
    const file = (counts[error.filename] ??= {});
    const rule = (file[ruleName(error.code)] ??= { count: 0 });
    rule.count += 1;
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(Object.keys(counts[file]).sort().map((rule) => [rule, counts[file][rule]])),
      ]),
  );
}

function readSuppressions() {
  return existsSync(SUPPRESSIONS) ? JSON.parse(readFileSync(SUPPRESSIONS, "utf8")) : {};
}

/** The errors the suppressions do not cover, and the entries no error needs any more. */
function reconcile(errors, suppressions) {
  const remaining = structuredClone(suppressions);
  const unsuppressed = [];
  for (const error of errors) {
    const entry = remaining[error.filename]?.[ruleName(error.code)];
    if (entry !== undefined && entry.count > 0) {
      entry.count -= 1;
    } else {
      unsuppressed.push(error);
    }
  }
  const stale = [];
  for (const [file, rules] of Object.entries(remaining)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      if (count > 0) {
        stale.push(`${file}: ${rule} (${count})`);
      }
    }
  }
  return { unsuppressed, stale };
}

function formatDiagnostic(diagnostic) {
  const span = diagnostic.labels[0]?.span;
  const where = span === undefined ? diagnostic.filename : `${diagnostic.filename}:${span.line}:${span.column}`;
  const help = diagnostic.help ? ` (${diagnostic.help})` : "";
  return `${where}: ${diagnostic.severity} ${ruleName(diagnostic.code)}: ${diagnostic.message}${help}`;
}

function main(argv) {
  const write = argv.includes("--write");
  const paths = argv.filter((argument) => argument !== "--write");
  const diagnostics = lint(paths);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
  for (const warning of warnings) {
    console.log(formatDiagnostic(warning));
  }
  if (write) {
    writeFileSync(SUPPRESSIONS, `${JSON.stringify(tally(errors), null, 2)}\n`);
    console.log(`${SUPPRESSIONS}: ${errors.length} errors recorded in ${Object.keys(tally(errors)).length} files`);
    return 0;
  }
  const { unsuppressed, stale } = reconcile(errors, readSuppressions());
  for (const error of unsuppressed) {
    console.log(formatDiagnostic(error));
  }
  for (const entry of stale) {
    console.log(`${entry}: no longer an error; remove it from ${SUPPRESSIONS} (node scripts/lint.mjs --write)`);
  }
  const suppressed = errors.length - unsuppressed.length;
  console.log(
    `${unsuppressed.length} errors, ${warnings.length} warnings, ${suppressed} suppressed, ${stale.length} stale suppressions`,
  );
  return unsuppressed.length === 0 && stale.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
