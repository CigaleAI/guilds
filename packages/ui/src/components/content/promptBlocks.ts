/**
 * A system prompt section read as blocks: the tagged parts (`<state>…</state>`, an embedded note
 * `<note path="…">…</note>`) nested as they are written, and the text between them. Pure.
 */

export type PromptBlock =
  | { type: "text"; text: string }
  | {
      type: "tag";
      tag: string;
      /** The note an embedded note block carries, from its `path` attribute. */
      path: string | null;
      content: string;
      children: PromptBlock[] | null;
    };

const tagged = /<([a-zA-Z0-9_-]+)(?:\s+([^>]*))?>([\s\S]*?)<\/\1>/g;

function pathOf(attrs: string): string | null {
  const match = /(?:^|\s)path\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
  return (match?.[1] ?? match?.[2] ?? "").trim() || null;
}

export function promptBlocks(content: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let last = 0;
  for (const match of content.matchAll(tagged)) {
    const before = content.slice(last, match.index).trim();
    if (before) blocks.push({ type: "text", text: before });
    const inner = match[3] ?? "";
    const nested = new RegExp(tagged.source).test(inner);
    blocks.push({
      type: "tag",
      tag: match[1] ?? "",
      path: pathOf(match[2] ?? ""),
      content: inner.trim(),
      children: nested ? promptBlocks(inner) : null,
    });
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = content.slice(last).trim();
  if (rest) blocks.push({ type: "text", text: rest });
  return blocks;
}

/** Text as it reads best: a JSON value to show as a tree, or Markdown. */
export type PromptText =
  { kind: "json"; value: unknown; lead: string } | { kind: "markdown"; text: string };

function json(text: string): unknown {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Reads text that is JSON, or a line of words followed by JSON, as a JSON value. */
export function promptText(text: string): PromptText {
  const whole = json(text);
  if (whole !== undefined) return { kind: "json", value: whole, lead: "" };
  const brace = text.search(/[[{]/);
  if (brace > 0) {
    const tail = json(text.slice(brace));
    if (tail !== undefined) return { kind: "json", value: tail, lead: text.slice(0, brace).trim() };
  }
  return { kind: "markdown", text };
}
