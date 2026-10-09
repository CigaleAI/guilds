/** Words that mark a tool name as writing: a tool named with one is treated as mutating. */
const MUTATING_TOKENS = new Set([
  "accept",
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "batch",
  "burn",
  "buy",
  "cancel",
  "close",
  "complete",
  "compose",
  "create",
  "delete",
  "draft",
  "duplicate",
  "edit",
  "execute",
  "insert",
  "invite",
  "label",
  "manage",
  "mark",
  "mint",
  "modify",
  "move",
  "patch",
  "publish",
  "put",
  "remove",
  "rename",
  "reopen",
  "reply",
  "restore",
  "revoke",
  "save",
  "sell",
  "send",
  "set",
  "share",
  "sign",
  "star",
  "submit",
  "swap",
  "transfer",
  "trash",
  "unarchive",
  "unassign",
  "unlabel",
  "unpublish",
  "unstar",
  "untrash",
  "update",
  "upload",
  "write",
]);

function nameTokens(remoteName: string): string[] {
  return remoteName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a tool's name carries a writing verb, in snake, kebab, or camel case. */
export function nameMutates(remoteName: string): boolean {
  return nameTokens(remoteName).some((token) => MUTATING_TOKENS.has(token));
}
