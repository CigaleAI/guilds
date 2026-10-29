import { Type } from "@sinclair/typebox";

/** The path of a route under one guild. */
export const GuildParams = Type.Object({ guild_id: Type.String() });

/** The path of a route under one agent. */
export const AgentParams = Type.Object({ agent_id: Type.String() });

/** The path of a route under one organisation. */
export const OrgParams = Type.Object({ org_id: Type.String() });
