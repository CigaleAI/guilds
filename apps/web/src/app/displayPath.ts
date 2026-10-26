/** The scope a display path belongs to: an agent's items, a guild's, or the organisation's. */
export function scopeOfDisplayPath(path: string): "agent" | "guild" | "org" {
  if (/(^|\/)agents\//.test(path)) return "agent";
  if (/(^|\/)guilds\//.test(path)) return "guild";
  return "org";
}
