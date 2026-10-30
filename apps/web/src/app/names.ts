/** Guild and agent names: a lowercase letter, then up to 62 lowercase letters, digits or hyphens. */
export const handlePattern = /^[a-z][a-z0-9-]{0,62}$/;

export const handleHint = "Lowercase letters, digits and hyphens, starting with a letter.";

export function handleError(name: string): string | undefined {
  if (!name) return undefined;
  return handlePattern.test(name) ? undefined : handleHint;
}

/** An agent's name, including the reserved `@user` tag. */
export function agentHandleError(name: string): string | undefined {
  if (!name) return undefined;
  if (name === "user") return "Reserved for tagging every operator.";
  return handleError(name);
}

/**
 * Handle error while the operator is typing. Empty stays quiet until they have started, then the
 * format rule (and `@user` on an agent) shows as they type.
 */
export function liveHandleError(
  name: string,
  started: boolean,
  kind: "guild" | "agent" = "guild",
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return started ? handleHint : undefined;
  return kind === "agent" ? agentHandleError(trimmed) : handleError(trimmed);
}
