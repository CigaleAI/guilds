/**
 * The coding harnesses a coding agent delegates code work to. Each runs headless in the
 * agent's sandbox on the user's own subscription: a token granted to the agent as a secret,
 * or a login stored in the agent's home.
 */
export const HARNESSES = ["claude-code", "codex", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export type HarnessInfo = {
  harness: Harness;
  label: string;
  /** The secret holding a long-lived subscription token; null when the harness has none. */
  secret: string | null;
  /** What to run in the agent's CLI tab to log in. */
  login: string;
};

export const HARNESS_INFO: Record<Harness, HarnessInfo> = {
  "claude-code": {
    harness: "claude-code",
    label: "Claude Code",
    secret: "CLAUDE_CODE_OAUTH_TOKEN",
    login: "claude, then /login",
  },
  codex: {
    harness: "codex",
    label: "Codex",
    secret: null,
    login: "codex login --device-auth",
  },
  cursor: {
    harness: "cursor",
    label: "Cursor",
    secret: "CURSOR_API_KEY",
    login: "NO_OPEN_BROWSER=1 agent login",
  },
};

const HARNESS_SET = new Set<string>(HARNESSES);

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && HARNESS_SET.has(value);
}

/** The agent's harness from its config; null when none is set. */
export function harnessOf(config: Record<string, unknown> | null | undefined): Harness | null {
  return isHarness(config?.harness) ? config.harness : null;
}

/** How a credential problem names its fix: the secret to grant, or the login to run. */
export function credentialFix(harness: Harness, options: { cli: boolean }): string {
  const info = HARNESS_INFO[harness];
  const ways: string[] = [];
  if (info.secret) {
    ways.push(`grant the secret ${info.secret} to the agent`);
  }
  if (options.cli) {
    ways.push(`log in from the agent's CLI tab with \`${info.login}\``);
  }
  if (!ways.length) {
    return `${info.label} needs a login from the agent's CLI tab, and this agent has the CLI turned off`;
  }
  return ways.join(", or ");
}
