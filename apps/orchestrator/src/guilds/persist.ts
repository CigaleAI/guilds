import {
  DEFAULT_AGENT_MESSAGE_LIMIT,
  DEFAULT_GUILD_AGENTS,
  type GuildVisibility,
} from "./validation.js";
import { deleteGuild, insertGuild } from "../db/guilds.js";
import { bindQuery, type Queryable } from "../db/pg.js";

export type GuildNotes = {
  createGuild(orgSlug: string, name: string): Promise<void>;
};

/** The db/ functions a new guild is written through, on `db`. */
export function guildDatabase(db: Queryable) {
  return {
    insertGuild: bindQuery(db, insertGuild),
    deleteGuild: bindQuery(db, deleteGuild),
  };
}

export type GuildDatabase = ReturnType<typeof guildDatabase>;

export async function persistGuild(
  db: GuildDatabase,
  notes: GuildNotes,
  args: {
    guildId: string;
    name: string;
    now: Date;
    orgId: string;
    orgSlug: string;
    about?: string;
    description?: string;
    groupAgentMessageLimit?: number;
    visibility?: GuildVisibility;
    creatorUserId: string;
    maxAgents?: number;
  },
): Promise<void> {
  const about = args.about ?? "";
  const description = args.description ?? "";
  const visibility = args.visibility ?? "org";
  await db.insertGuild(
    {
      guildId: args.guildId,
      name: args.name,
      orgId: args.orgId,
      about,
      agentMessageLimit: args.groupAgentMessageLimit ?? DEFAULT_AGENT_MESSAGE_LIMIT,
      visibility,
      creatorUserId: args.creatorUserId,
      description,
      maxAgents: args.maxAgents ?? DEFAULT_GUILD_AGENTS,
    },
    args.now,
  );
  try {
    await notes.createGuild(args.orgSlug, args.name);
  } catch (error) {
    await db.deleteGuild(args.guildId);
    throw error;
  }
}
