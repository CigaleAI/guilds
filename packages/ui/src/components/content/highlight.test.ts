import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight, type CodeLine } from "./highlight";

/** The coloured runs of a line, in order. */
const kinds = (line: CodeLine | undefined) =>
  (line ?? []).filter((span) => span.kind !== "plain").map((span) => span.kind);

test("python keywords, the name after def, numbers and strings each get their colour", () => {
  const [line] = highlight('def run(since="2h", threshold=0.72):', "python");
  assert.deepEqual(
    line?.map((span) => [span.kind, span.text]),
    [
      ["keyword", "def"],
      ["plain", " "],
      ["function", "run"],
      ["plain", "(since="],
      ["string", '"2h"'],
      ["plain", ", threshold="],
      ["number", "0.72"],
      ["plain", "):"],
    ],
  );
});

test("a triple-quoted string spans lines and a final newline opens no blank line", () => {
  const lines = highlight('"""Score posts;\nwrite keepers."""\nfrom guilds import tables\n', "python");
  assert.equal(lines.length, 3);
  assert.deepEqual(kinds(lines[0]), ["string"]);
  assert.deepEqual(kinds(lines[1]), ["string"]);
  assert.deepEqual(kinds(lines[2]), ["keyword", "keyword"]);
});

test("comments run to the line end, decorators open a line, prefixed strings stay strings", () => {
  const lines = highlight("@tool  # also a tool\nname = rf'{x}'  # raw\n", "python");
  assert.deepEqual(kinds(lines[0]), ["decorator", "comment"]);
  assert.deepEqual(kinds(lines[1]), ["string", "comment"]);
});

test("an unterminated one-line string stops at the line end", () => {
  const lines = highlight("a = 'open\nb = 1", "python");
  assert.deepEqual(kinds(lines[0]), ["string"]);
  assert.deepEqual(kinds(lines[1]), ["number"]);
});

test("hex, underscored and exponent numbers are one run each", () => {
  const [line] = highlight("0x1F 1_000 2.5e-3 .5", "python");
  assert.deepEqual(
    line?.filter((span) => span.kind === "number").map((span) => span.text),
    ["0x1F", "1_000", "2.5e-3", ".5"],
  );
});

test("json colours strings, numbers and its three literals", () => {
  const [line] = highlight('{"type": "object", "required": true, "n": 3, "x": null}', "json");
  assert.deepEqual(kinds(line), [
    "string",
    "string",
    "string",
    "keyword",
    "string",
    "number",
    "string",
    "keyword",
  ]);
});

test("plain text is one run per line", () => {
  const lines = highlight("def not python\nsecond", "text");
  assert.deepEqual(
    lines.map((line) => line.map((span) => span.kind)),
    [["plain"], ["plain"]],
  );
});

test("a blank line is an empty array", () => {
  const lines = highlight("a\n\nb", "python");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1], []);
});
