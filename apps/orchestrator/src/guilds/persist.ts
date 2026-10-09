import {
  DEFAULT_AGENT_MESSAGE_LIMIT,
  DEFAULT_GUILD_AGENTS,
  type GuildVisibility,
} from "./validation.js";

export type GuildNotes = {
  createGuild(orgSlug: string, name: string): Promise<void>;
};

export type GuildDatabase = {
  insertGuild(
    guildId: string,
    name: string,
    now: Date,
    orgId: string,
    about: string,
    agentMessageLimit?: number,
    visibility?: string,
    creatorUserId?: string | null,
    description?: string,
    maxAgents?: number,
  ): Promise<void>;
  deleteGuild(guildId: string): Promise<void>;
};

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
    args.guildId,
    args.name,
    args.now,
    args.orgId,
    about,
    args.groupAgentMessageLimit ?? DEFAULT_AGENT_MESSAGE_LIMIT,
    visibility,
    args.creatorUserId,
    description,
    args.maxAgents ?? DEFAULT_GUILD_AGENTS,
  );
  try {
    await notes.createGuild(args.orgSlug, args.name);
  } catch (error) {
    await db.deleteGuild(args.guildId);
    throw error;
  }
}
