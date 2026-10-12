/** The languages the code block colours; anything else reads as plain text. */
export type CodeLanguage = "python" | "json" | "text";

export type CodeSpanKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "function"
  | "decorator";

export type CodeSpan = { kind: CodeSpanKind; text: string };

/** One line of source as coloured runs; an empty array is a blank line. */
export type CodeLine = CodeSpan[];

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const JSON_KEYWORDS = new Set(["true", "false", "null"]);

const SPACE = /[ \t]+/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?j?/y;
const PYTHON_STRING = /(?:[rRbBuUfF]{1,2})?('''|"""|'|")/y;
const JSON_STRING = /(")/y;
const DECORATOR = /@[A-Za-z_][\w.]*/y;

/** Where a string opened at `from` ends: after its closing quote, at the line end when a one-line string never closes, or at the end of the source. */
function stringEnd(source: string, from: number, quote: string): number {
  const multiline = quote.length === 3;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!multiline && ch === "\n") return i;
    if (source.startsWith(quote, i)) return i + quote.length;
    i += 1;
  }
  return source.length;
}

function tokenize(source: string, language: CodeLanguage): CodeSpan[] {
  if (language === "text") return [{ kind: "plain", text: source }];
  const python = language === "python";
  const keywords = python ? PYTHON_KEYWORDS : JSON_KEYWORDS;
  const stringStart = python ? PYTHON_STRING : JSON_STRING;
  const spans: CodeSpan[] = [];
  const push = (kind: CodeSpanKind, text: string) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === "plain" && kind === "plain") last.text += text;
    else spans.push({ kind, text });
  };
  let i = 0;
  let lineStart = true;
  let naming = false;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === "\n") {
      push("plain", ch);
      i += 1;
      lineStart = true;
      naming = false;
      continue;
    }
    SPACE.lastIndex = i;
    const space = SPACE.exec(source);
    if (space) {
      push("plain", space[0]);
      i += space[0].length;
      continue;
    }
    if (python && ch === "#") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      push("comment", source.slice(i, stop));
      i = stop;
      continue;
    }
    if (python && lineStart && ch === "@") {
      DECORATOR.lastIndex = i;
      const decorator = DECORATOR.exec(source);
      if (decorator) {
        push("decorator", decorator[0]);
        i += decorator[0].length;
        lineStart = false;
        continue;
      }
    }
    stringStart.lastIndex = i;
    const string = stringStart.exec(source);
    if (string) {
      const end = stringEnd(source, i + string[0].length, string[1] ?? '"');
      push("string", source.slice(i, end));
      i = end;
      lineStart = false;
      naming = false;
      continue;
    }
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(source);
    if (number && number[0]) {
      push("number", number[0]);
      i += number[0].length;
      lineStart = false;
      naming = false;
      continue;
    }
    IDENT.lastIndex = i;
    const ident = IDENT.exec(source);
    if (ident) {
      const word = ident[0];
      push(naming ? "function" : keywords.has(word) ? "keyword" : "plain", word);
      naming = python && (word === "def" || word === "class");
      i += word.length;
      lineStart = false;
      continue;
    }
    push("plain", ch);
    i += 1;
    lineStart = false;
    naming = false;
  }
  return spans;
}

/** Colours source as lines of runs. A final newline closes the last line rather than opening a blank one. */
export function highlight(source: string, language: CodeLanguage): CodeLine[] {
  const lines: CodeLine[] = [[]];
  for (const span of tokenize(source, language)) {
    span.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]?.push({ kind: span.kind, text: part });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
  return lines;
}
