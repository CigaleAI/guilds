import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { identityHex, identityTones } from "./identity";
import { statusTone, wakeOutcomeLabel } from "./tones";

const uiDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(uiDir, "..");

/** Markdown spec of the live design system, for attaching in Claude Design. */
export function designSystemMarkdown(): string {
  const tokensCss = readFileSync(join(uiDir, "tokens.css"), "utf8");
  const themeCss = readFileSync(join(uiDir, "theme.css"), "utf8");
  const light = cssVariables(cssBlock(tokensCss, '[data-theme="light"]'));
  const dark = cssVariables(cssBlock(tokensCss, '[data-theme="dark"]'));
  const sections: string[] = [
    "# guilds.run design system",
    "",
    "Generated from `packages/ui` by `pnpm design-system-doc`. Do not edit.",
    "This is the live library (tokens, variants, Storybook stories). Attach this file in Claude Design.",
    "",
    "## Conventions",
    "",
    '- Theme is `data-theme="light"` or `data-theme="dark"` on `<html>`, never a `dark` class.',
    "- Colour, radius and shadow are Tailwind utilities named after tokens: `bg-surface`, `text-fg`, `rounded-md`, `shadow-pop`. Do not invent colours, radii or shadows.",
    "- Type is the `type-*` utilities, or the `Text` primitive. Manrope (sans) is for people; JetBrains Mono is for machine text (`type-label`, `type-code`, `type-meta`).",
    "- Components take the named variants below. Do not restyle them with new colours.",
    "- Depth is stacked colour first (`page` → `well` → `surface` → `paper`); `shadow-pop` / `shadow-float` / `shadow-modal` are for overlays.",
    "",
    "## Colour tokens",
    "",
    "Brand constants never change with the theme. Components use semantic tokens only.",
    "",
    "### Light (and brand)",
    "",
    tokenTable(light),
    "",
    "### Dark overrides",
    "",
    tokenTable(dark),
    "",
    "## Type",
    "",
    "Fonts: Manrope Variable (sans), JetBrains Mono (mono).",
    "",
    scaleTable(themeCss, "--text-", "text-"),
    "",
    "Composite styles (`type-*`); colour stays separate:",
    "",
    typeUtilities(themeCss),
    "",
    "## Radius",
    "",
    scaleTable(themeCss, "--radius-", "rounded-"),
    "",
    "## Elevation",
    "",
    "- `shadow-pop` — menus, toasts, popovers (`--elev-pop`)",
    "- `shadow-float` — app frames (`--elev-float`)",
    "- `shadow-modal` — dialogs, sheets (`--elev-modal`)",
    "",
    "## Identity",
    "",
    "Every agent owns one of these. Avatar fill is `bg-id-{tone}` with `text-on-id` initials; the name is `text-id-{tone}-t`. Soft ground (a person's bubble) is `bg-id-{tone}-tint`.",
    "",
    identityTones.map((tone) => `- ${tone} \`${identityHex[tone]}\``).join("\n"),
    "",
    "## Status and wakes",
    "",
    "A `Tone` is `signal | tide | dusk | ochre | plum | idle`. Domain state maps through these:",
    "",
    Object.entries(statusTone)
      .map(([status, tone]) => `- status \`${status}\` → \`${tone}\``)
      .join("\n"),
    "",
    Object.entries(wakeOutcomeLabel)
      .map(([outcome, label]) => `- wake \`${outcome}\` — ${label}`)
      .join("\n"),
    "",
    "## Library",
    "",
    "Storybook sidebar order: Foundations, Primitives, Components. A story file sits next to the module.",
    "",
  ];

  for (const entry of libraryEntries()) {
    sections.push(`### ${entry.title}`, "");
    if (entry.path) sections.push(`\`${entry.path}\``, "");
    if (entry.docs.length) {
      for (const doc of entry.docs) {
        sections.push(doc.name ? `**${doc.name}.** ${doc.text}` : doc.text, "");
      }
    }
    for (const cva of entry.cvas) {
      const keys = Object.entries(cva.variants)
        .map(([axis, values]) => `${axis}: ${values.join(" | ")}`)
        .join("; ");
      const defaults = Object.entries(cva.defaults)
        .map(([axis, value]) => `${axis}=${value}`)
        .join(", ");
      sections.push(
        `- \`${cva.name}\`${keys ? ` — ${keys}` : ""}${defaults ? ` (default ${defaults})` : ""}`,
      );
    }
    if (entry.cvas.length) sections.push("");
    if (entry.stories.length) {
      sections.push(`Stories: ${entry.stories.join(", ")}`, "");
    }
  }

  return `${sections.join("\n").trim()}\n`;
}

export function writeDesignSystemDoc(outPath = join(packageRoot, "design-system.md")): string {
  writeFileSync(outPath, designSystemMarkdown());
  return outPath;
}

type DocNote = { name: string; text: string };
type CvaDoc = {
  name: string;
  variants: Record<string, string[]>;
  defaults: Record<string, string>;
};
type LibraryEntry = {
  title: string;
  path: string;
  docs: DocNote[];
  cvas: CvaDoc[];
  stories: string[];
};

function libraryEntries(): LibraryEntry[] {
  const storyFiles = filesEnding(".stories.tsx").filter(
    (path) => !path.endsWith("writeDesignSystemDoc.stories.tsx"),
  );
  const entries: LibraryEntry[] = [];
  const withStory = new Set<string>();

  for (const storyPath of storyFiles) {
    const source = readFileSync(storyPath, "utf8");
    const title = /title:\s*"([^"]+)"/.exec(source)?.[1] ?? relative(uiDir, storyPath);
    const stories = [...source.matchAll(/^export const ([A-Z]\w+)/gm)].map((match) => match[1]!);
    const modulePath = storyPath.replace(/\.stories\.tsx$/, ".tsx");
    withStory.add(modulePath);
    const moduleSource = readIfFile(modulePath);
    entries.push({
      title,
      path: relative(packageRoot, moduleSource ? modulePath : storyPath),
      docs: moduleSource ? jsdocs(moduleSource) : [],
      cvas: moduleSource ? parseCvaDocs(moduleSource) : [],
      stories,
    });
  }

  for (const path of filesEnding(".tsx")) {
    if (path.endsWith(".stories.tsx") || path.endsWith(".test.ts") || withStory.has(path)) continue;
    if (path.endsWith("writeDesignSystemDoc.ts")) continue;
    const rel = relative(uiDir, path);
    if (rel.startsWith("foundations/")) continue;
    const source = readFileSync(path, "utf8");
    const segs = rel
      .replace(/\.tsx$/, "")
      .replaceAll("\\", "/")
      .split("/");
    const title =
      segs[0] === "primitives"
        ? `Primitives/${segs.slice(1).join("/")}`
        : segs[0] === "components"
          ? `Components/${segs
              .slice(1)
              .map((seg, i, all) =>
                i < all.length - 1 ? `${seg.slice(0, 1).toUpperCase()}${seg.slice(1)}` : seg,
              )
              .join("/")}`
          : segs.join("/");
    entries.push({
      title,
      path: relative(packageRoot, path),
      docs: jsdocs(source),
      cvas: parseCvaDocs(source),
      stories: [],
    });
  }

  return entries.sort(
    (a, b) => libraryOrder(a.title) - libraryOrder(b.title) || a.title.localeCompare(b.title),
  );
}

function libraryOrder(title: string): number {
  if (title === "Foundations" || title.startsWith("Foundations/")) return 0;
  if (title.startsWith("Primitives/")) return 1;
  if (title.startsWith("Components/")) return 2;
  return 3;
}

function filesEnding(suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(uiDir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(join(entry.parentPath, entry.name));
    }
  }
  return out.sort();
}

function readIfFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function cssBlock(css: string, marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  if (open < 0) return "";
  return balanced(css, open, "{", "}");
}

function cssVariables(block: string): { name: string; value: string; note: string }[] {
  const tokens: { name: string; value: string; note: string }[] = [];
  let note = "";
  for (const raw of block.split("\n")) {
    const comment = /^\s*\/\*\s*(.*?)\s*\*\/\s*$/.exec(raw);
    if (comment) {
      note = comment[1] ?? "";
      continue;
    }
    const token = /^\s*--([a-z0-9-]+):\s*(.+?);\s*$/.exec(raw);
    if (!token) continue;
    tokens.push({ name: token[1]!, value: token[2]!.trim(), note });
    note = "";
  }
  return tokens;
}

function tokenTable(tokens: { name: string; value: string; note: string }[]): string {
  const rows = ["| Token | Value |", "| --- | --- |"];
  for (const token of tokens) {
    const note = token.note ? ` — ${token.note}` : "";
    rows.push(`| \`--${token.name}\` | \`${token.value}\`${note} |`);
  }
  return rows.join("\n");
}

function scaleTable(css: string, prefix: string, utility: string): string {
  const rows = ["| Token | Value | Utility |", "| --- | --- | --- |"];
  const re = new RegExp(`${prefix.replaceAll("-", "\\-")}([a-z0-9]+):\\s*([^;]+);`, "g");
  for (const match of css.matchAll(re)) {
    const name = match[1]!;
    if (name.includes("-")) continue;
    rows.push(`| \`${prefix}${name}\` | \`${match[2]!.trim()}\` | \`${utility}${name}\` |`);
  }
  return rows.join("\n");
}

function typeUtilities(css: string): string {
  const lines: string[] = [];
  const re = /@utility (type-\w+) \{([^}]+)\}/g;
  for (const match of css.matchAll(re)) {
    const body = match[2]!
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("; ");
    lines.push(`- \`${match[1]}\` — ${body}`);
  }
  return lines.join("\n");
}

function jsdocs(source: string): DocNote[] {
  const notes: DocNote[] = [];
  const re = /export (?:function|const) (\w+)/g;
  for (const match of source.matchAll(re)) {
    const text = lastJsdoc(source.slice(0, match.index));
    if (text) notes.push({ name: match[1]!, text });
  }
  return notes;
}

function lastJsdoc(before: string): string | undefined {
  const matches = [...before.matchAll(/\/\*\*\s*([\s\S]*?)\s*\*\//g)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return undefined;
  if (before.slice(last.index + last[0].length).trim() !== "") return undefined;
  const text = last[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line && !line.startsWith("@"))
    .join(" ");
  return text || undefined;
}

function parseCvaDocs(source: string): CvaDoc[] {
  const docs: CvaDoc[] = [];
  const re = /export const (\w+) = cva\s*\(/g;
  for (const match of source.matchAll(re)) {
    const name = match[1]!;
    const open = source.indexOf("(", match.index! + match[0].length - 1);
    const call = balanced(source, open, "(", ")");
    const variantsAt = call.indexOf("variants:");
    if (variantsAt < 0) continue;
    const variantsOpen = call.indexOf("{", variantsAt);
    const variants = objectKeys(balanced(call, variantsOpen, "{", "}"));
    const defaultsAt = call.indexOf("defaultVariants:");
    const defaults: Record<string, string> = {};
    if (defaultsAt >= 0) {
      const defaultsOpen = call.indexOf("{", defaultsAt);
      for (const [axis, raw] of Object.entries(
        objectProps(balanced(call, defaultsOpen, "{", "}")),
      )) {
        defaults[axis] = raw.replace(/^["']|["']$/g, "");
      }
    }
    docs.push({ name, variants, defaults });
  }
  return docs;
}

/** Variant axes → option names inside a `variants` object. */
function objectKeys(objectText: string): Record<string, string[]> {
  const axes: Record<string, string[]> = {};
  for (const [axis, raw] of Object.entries(objectProps(objectText))) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) {
      axes[axis] = [trimmed.replace(/^["']|["']$/g, "")];
      continue;
    }
    axes[axis] = Object.keys(objectProps(trimmed));
  }
  return axes;
}

function objectProps(objectText: string): Record<string, string> {
  const body = objectText.trim().replace(/^\{|\}$/g, "");
  const props: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i += 1;
    if (i >= body.length) break;
    const keyMatch = /^["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(body.slice(i));
    if (!keyMatch) break;
    i += keyMatch[0].length;
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    const start = i;
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      const close = ch === "{" ? "}" : ch === "(" ? ")" : "]";
      const block = balanced(body, i, ch, close);
      props[keyMatch[1]!] = block;
      i += block.length;
    } else if (ch === '"' || ch === "'") {
      i += 1;
      while (i < body.length && body[i] !== ch) {
        if (body[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      props[keyMatch[1]!] = body.slice(start, i).trim();
    } else {
      while (i < body.length && body[i] !== "," && body[i] !== "\n") i += 1;
      props[keyMatch[1]!] = body.slice(start, i).trim();
    }
  }
  return props;
}

function balanced(source: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\" && quote !== "`") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return source.slice(openIdx);
}

const runningAsCli = argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(argv[1]);

if (runningAsCli) {
  stdout.write(`${writeDesignSystemDoc()}\n`);
}
