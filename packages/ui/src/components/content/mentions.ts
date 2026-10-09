import { replaceInText, spanNode, type MdNode } from "./textNodes";

/** `@handle` as the orchestrator reads tags in a group-chat message. */
export const MENTION_PATTERN = /(?<![A-Za-z0-9-])@([a-z][a-z0-9-]{0,62})\b/g;

/** Whether a name can be tagged: a lowercase handle the orchestrator recognises after `@`. */
export function isHandle(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(name);
}

/**
 * Remark plugin: turns `@handle` into `<span data-mention>` for the handles the message actually
 * tagged (the server's `tagged` list); any other `@word` stays text.
 */
export function remarkMentions(options: { names: readonly string[] }) {
  const names = new Set(options.names);
  return (tree: MdNode) => {
    if (names.size === 0) return;
    replaceInText(tree, MENTION_PATTERN, (match) => {
      const handle = match[1] ?? "";
      return names.has(handle) ? spanNode("mention", { dataMention: handle }, `@${handle}`) : null;
    });
  };
}
