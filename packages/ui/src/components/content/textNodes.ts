/** A Markdown syntax-tree node, as far as the text plugins need it. */
export type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

/** A node that renders as `<span {...properties}>{label}</span>`. */
export function spanNode(type: string, properties: Record<string, string>, label: string): MdNode {
  return {
    type,
    data: { hName: "span", hProperties: properties, hChildren: [{ type: "text", value: label }] },
  };
}

/**
 * Replaces each match of `pattern` in text nodes with the node `make` returns (null keeps the
 * match as text). Code spans and blocks are separate node types, so their text stays literal.
 */
export function replaceInText(
  tree: MdNode,
  pattern: RegExp,
  make: (match: RegExpMatchArray) => MdNode | null,
): void {
  if (!tree.children) return;
  const next: MdNode[] = [];
  for (const child of tree.children) {
    if (child.type !== "text" || !child.value) {
      replaceInText(child, pattern, make);
      next.push(child);
      continue;
    }
    const value = child.value;
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      const node = make(match);
      if (!node) continue;
      if (match.index > last) next.push({ type: "text", value: value.slice(last, match.index) });
      next.push(node);
      last = match.index + match[0].length;
    }
    if (last === 0) next.push(child);
    else if (last < value.length) next.push({ type: "text", value: value.slice(last) });
  }
  tree.children = next;
}
