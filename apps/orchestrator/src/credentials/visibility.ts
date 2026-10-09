export function visibleAt(
  ownerScope: string,
  ownerId: string | null | undefined,
  args: {
    scope: string;
    scopeId: string | null | undefined;
    guildId?: string | null;
    orgId?: string | null;
  },
): boolean {
  if (ownerScope === "platform") {
    return true;
  }
  if (ownerScope === "org") {
    if (args.scope === "org") {
      return ownerId === args.scopeId;
    }
    if (args.scope === "guild" || args.scope === "agent") {
      return ownerId === args.orgId;
    }
    return false;
  }
  if (ownerScope === "guild") {
    if (args.scope === "guild") {
      return ownerId === args.scopeId;
    }
    if (args.scope === "agent") {
      return ownerId === args.guildId;
    }
    return false;
  }
  return args.scope === "agent" && ownerId === args.scopeId;
}
