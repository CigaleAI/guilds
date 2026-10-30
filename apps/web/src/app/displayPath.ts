/** The scope a display path belongs to: an agent's items, a guild's, or the organisation's. */
export function scopeOfDisplayPath(path: string): "agent" | "guild" | "org" {
  if (/(^|\/)agents\//.test(path)) return "agent";
  if (/(^|\/)guilds\//.test(path)) return "guild";
  return "org";
}

/** The scope a browser opens on to show a display path first: the path's own, when the browser offers it. */
export function openingScope<Scope extends { id: string }>(
  scopes: readonly Scope[],
  path: string | undefined,
): Scope | undefined {
  if (!path) return undefined;
  const id = scopeOfDisplayPath(path);
  return scopes.find((scope) => scope.id === id);
}
