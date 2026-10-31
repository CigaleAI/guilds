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

/** The server's rule for a guild repository's name, which is also its folder under repos/ in each coding agent's home. */
export const repositoryNamePattern = /^[a-z][a-z0-9_-]{0,62}$/;

/** Why the server would refuse a repository name as typed; undefined while it is empty or valid. */
export function repositoryNameError(name: string): string | undefined {
  return name && !repositoryNamePattern.test(name)
    ? "Lowercase letters, digits, - and _, starting with a letter."
    : undefined;
}

/** A repository name the server accepts, derived from a GitHub repository's name. */
export function repositoryNameFrom(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 63);
  return cleaned || "repo";
}
