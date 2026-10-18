import { resolveItem } from "../access/index.js";
import {
  ARTIFACT_GRANT_IDS,
  DEFAULT_ARTIFACT_GRANTS,
  NO_HIDDEN_GUILDS,
  OPERATOR_GRANTS,
  type ArtifactActor,
  type ArtifactGrants,
  type HiddenGuilds,
} from "./types.js";

export function grantsFromBindings(
  rows: Array<Record<string, unknown>>,
  options: {
    orgId?: string | null;
    guildId?: string | null;
    agentId?: string | null;
  },
): ArtifactGrants {
  const grants = { ...DEFAULT_ARTIFACT_GRANTS };
  for (const id of ARTIFACT_GRANT_IDS) {
    const resolved = resolveItem(rows, "artifact_grant", id, options);
    const enabled = resolved.source_scope === null ? grantsForId(id) : resolved.enabled;
    if (id === "read_guild") grants.readGuild = enabled;
    if (id === "read_org") grants.readOrg = enabled;
    if (id === "write_guild") grants.writeGuild = enabled;
    if (id === "write_org") grants.writeOrg = enabled;
  }
  return grants;
}

function grantsForId(id: string): boolean {
  if (id === "write_org") {
    return false;
  }
  return true;
}

export function catalogLevels(grants: ArtifactGrants): {
  readable: string[];
  writable: string[];
} {
  const readable = ["agent"];
  const writable = ["agent"];
  if (grants.readGuild) readable.push("guild");
  if (grants.readOrg) readable.push("org");
  if (grants.writeGuild) writable.push("guild");
  if (grants.writeOrg) writable.push("org");
  return { readable, writable };
}

export function operatorActor(args: {
  orgId: string;
  actorId: string;
  actorName: string;
  guildId?: string | null;
  agentId?: string | null;
  hidden?: HiddenGuilds;
}): ArtifactActor {
  return {
    orgId: args.orgId,
    guildId: args.guildId ?? null,
    agentId: args.agentId ?? null,
    operator: true,
    hidden: args.hidden ?? NO_HIDDEN_GUILDS,
    grants: OPERATOR_GRANTS,
    actorType: "user",
    actorId: args.actorId,
    actorName: args.actorName,
    toolCall: null,
  };
}

export function agentActor(args: {
  orgId: string;
  guildId: string;
  agentId: string;
  agentName: string;
  grants: ArtifactGrants;
  runId?: string;
}): ArtifactActor {
  return {
    orgId: args.orgId,
    guildId: args.guildId,
    agentId: args.agentId,
    operator: false,
    hidden: NO_HIDDEN_GUILDS,
    grants: args.grants,
    actorType: args.runId ? "run" : "agent",
    actorId: args.runId ?? args.agentId,
    actorName: args.agentName,
    toolCall: null,
  };
}
