// Fails when the import graph of src/ gains a cycle. Value imports only; `import type` is ignored.
//
//   tsx scripts/import-cycles.ts            compares src/ with import-cycles.json
//   tsx scripts/import-cycles.ts --write    rewrites import-cycles.json from src/ as it is
//
// import-cycles.json lists the files that sit in a cycle today and the domains (directories under
// src/) that sit in a domain-level cycle. Like eslint-suppressions.json, it only shrinks: a file or
// a domain that enters a cycle fails the check, one that leaves it is reported so the list can be
// rewritten.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The package directory is the script's parent, or the first argument when given.
const given = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const PACKAGE = given ? resolve(given) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE, "src");
const BASELINE = join(PACKAGE, "import-cycles.json");

type Baseline = { filesInCycles: string[]; domainsInCycles: string[] };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts"))
      out.push(path);
  }
  return out.sort();
}

const files = sourceFiles(SRC);
const known = new Set(files);
const id = (path: string): string => relative(SRC, path).split(sep).join("/");
const domainOf = (path: string): string => {
  const [first, ...rest] = id(path).split("/");
  return rest.length === 0 || first === undefined ? "(root)" : first;
};

function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    join(base, "index.ts"),
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

// An import or re-export statement that is not `import type` / `export type`, plus dynamic
// import(). A clause whose every specifier is `type X` is a type-only import and is skipped.
const STATEMENT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const SIDE_EFFECT = /^\s*import\s+['"]([^'"]+)['"]/gm;

function valueImports(file: string): Set<string> {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const targets = new Set<string>();
  for (const pattern of [STATEMENT, DYNAMIC, SIDE_EFFECT]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const [statement, specifier] = match;
      const clause = statement.match(/\{([^}]*)\}/)?.[1];
      if (clause !== undefined) {
        const names = clause
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        if (names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
      }
      const target = specifier === undefined ? null : resolveSpecifier(file, specifier);
      if (target && target !== file) targets.add(target);
    }
  }
  return targets;
}

// Tarjan's algorithm: every node gets the index of its visit and the lowest index it reaches.
type Visit = { index: number; low: number; onStack: boolean };

function stronglyConnected(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const visits = new Map<string, Visit>();
  const stack: string[] = [];
  const components: string[][] = [];
  const visit = (node: string): Visit => {
    const own: Visit = { index: visits.size, low: visits.size, onStack: true };
    visits.set(node, own);
    stack.push(node);
    for (const target of edges.get(node) ?? []) {
      const seen = visits.get(target);
      if (seen === undefined) {
        own.low = Math.min(own.low, visit(target).low);
      } else if (seen.onStack) {
        own.low = Math.min(own.low, seen.index);
      }
    }
    if (own.low !== own.index) return own;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      const visited = visits.get(member);
      if (visited !== undefined) visited.onStack = false;
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
    return own;
  };
  for (const node of nodes) if (!visits.has(node)) visit(node);
  return components.filter((component) => component.length > 1);
}

const fileEdges = new Map(files.map((file) => [file, valueImports(file)]));
const domainEdges = new Map<string, Set<string>>();
for (const [from, targets] of fileEdges) {
  const domain = domainOf(from);
  const reached = domainEdges.get(domain) ?? new Set<string>();
  domainEdges.set(domain, reached);
  for (const to of targets) {
    if (domainOf(to) !== domain) reached.add(domainOf(to));
  }
}

const current: Baseline = {
  filesInCycles: stronglyConnected(files, fileEdges).flat().map(id).sort(),
  domainsInCycles: stronglyConnected([...new Set(files.map(domainOf))], domainEdges)
    .flat()
    .sort(),
};

if (process.argv.includes("--write")) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `import-cycles: wrote ${id(BASELINE)}: ${current.filesInCycles.length} files, ${current.domainsInCycles.length} domains in cycles`,
  );
  process.exit(0);
}

const baseline: Baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const entered = {
  files: current.filesInCycles.filter((file) => !baseline.filesInCycles.includes(file)),
  domains: current.domainsInCycles.filter((domain) => !baseline.domainsInCycles.includes(domain)),
};
const left = {
  files: baseline.filesInCycles.filter((file) => !current.filesInCycles.includes(file)),
  domains: baseline.domainsInCycles.filter((domain) => !current.domainsInCycles.includes(domain)),
};

console.log(
  `import-cycles: ${current.filesInCycles.length} files in file cycles (baseline ${baseline.filesInCycles.length}), ` +
    `${current.domainsInCycles.length} domains in domain cycles (baseline ${baseline.domainsInCycles.length})`,
);
for (const file of entered.files) console.log(`  ✗ ${file} entered a file cycle`);
for (const domain of entered.domains) console.log(`  ✗ ${domain}/ entered a domain cycle`);
for (const file of left.files)
  console.log(`  ✓ ${file} left its cycle; run with --write to shrink the baseline`);
for (const domain of left.domains)
  console.log(`  ✓ ${domain}/ left its cycle; run with --write to shrink the baseline`);
process.exit(entered.files.length + entered.domains.length > 0 ? 1 : 0);
