import type { Guild } from "../../api/types";

/**
 * Guild admins change visibility and operators, clear the group chat, and delete the guild; anyone
 * who sees it does the rest.
 */
export function isGuildAdmin(guild: Pick<Guild, "operators">, userId: string): boolean {
  return guild.operators.some(
    (operator) => operator.user_id === userId && operator.role === "admin",
  );
}
