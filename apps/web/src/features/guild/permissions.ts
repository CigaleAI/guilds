import type { Guild, GuildOperator } from "../../api/types/guilds";

const operatorRoles = ["admin", "operator"] as const satisfies readonly GuildOperator["role"][];

/** Whether a value names a role a guild operator holds. */
export function isOperatorRole(value: unknown): value is GuildOperator["role"] {
  return operatorRoles.some((role) => role === value);
}

/**
 * Guild admins change visibility and operators, clear the group chat, and delete the guild; anyone
 * who sees it does the rest.
 */
export function isGuildAdmin(guild: Pick<Guild, "operators">, userId: string): boolean {
  return guild.operators.some(
    (operator) => operator.user_id === userId && operator.role === "admin",
  );
}
