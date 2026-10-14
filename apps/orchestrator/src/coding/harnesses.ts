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

/** Where the runtime image lists the harness CLIs it carries, one per line. */
export const HARNESS_LIST = "/usr/local/share/guilds/harnesses";

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && HARNESS_SET.has(value);
}

/** The agent's harness from its config; null when none is set. */
export function harnessOf(config: Record<string, unknown> | null | undefined): Harness | null {
  return isHarness(config?.harness) ? config.harness : null;
}

/**
 * A harness model name: an alias or a full model name, with the bracketed parameters some
 * harnesses take (`claude-opus-4-8[context=1m]`). The driver passes it as one argument.
 */
export const HARNESS_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,119}$/;

/** The model the agent's harness runs; null leaves it to the harness's subscription. */
export function harnessModelOf(config: Record<string, unknown> | null | undefined): string | null {
  const model = config?.harness_model;
  return typeof model === "string" && HARNESS_MODEL_RE.test(model) ? model : null;
}

/** A coding run whose guild has no repository fails at start with this. */
export const REPOSITORIES_MISSING = "coding.repositories_missing";

export const REPOSITORIES_MISSING_MESSAGE =
  "this guild has no repositories: add one in the guild's Repositories, then send again";

/** What `agents.harness_logins` records per harness: when a check last found a login, and whose it is. */
export type HarnessLogin = { seen_at: string | null; account: string | null };

/** The login record for a harness as stored, or none. */
export function harnessLoginOf(logins: Record<string, unknown> | null | undefined, harness: Harness): HarnessLogin {
  const stored = logins?.[harness];
  if (typeof stored !== "object" || stored === null) {
    return { seen_at: null, account: null };
  }
  const record = stored as Record<string, unknown>;
  return {
    seen_at: typeof record.seen_at === "string" ? record.seen_at : null,
    account: typeof record.account === "string" ? record.account : null,
  };
}

/**
 * The secret the harness's token variable reads: the one the agent's aliases map it to, else the
 * variable's own name; null for a harness without a secret.
 */
export function harnessSecretSource(harness: Harness, aliases: Record<string, string>): string | null {
  const secret = HARNESS_INFO[harness].secret;
  return secret === null ? null : (aliases[secret] ?? secret);
}

/** How a credential problem names its fix: the secret to grant, or the login to run. */
export function credentialFix(
  harness: Harness,
  options: { cli: boolean; aliases?: Record<string, string> },
): string {
  const info = HARNESS_INFO[harness];
  const ways: string[] = [];
  const source = harnessSecretSource(harness, options.aliases ?? {});
  if (source !== null) {
    const as = source === info.secret ? "" : ` (read as ${info.secret})`;
    ways.push(`grant the secret ${source}${as} to the agent`);
  }
  if (options.cli) {
    ways.push(`log in from the agent's CLI tab with \`${info.login}\``);
  }
  if (!ways.length) {
    return `${info.label} needs a login from the agent's CLI tab, and this agent has the CLI turned off`;
  }
  return ways.join(", or ");
}
