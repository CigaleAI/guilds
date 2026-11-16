/**
 * The coding harnesses a coding agent delegates code work to, and a subscription agent runs every
 * turn on. Each runs headless in the agent's sandbox on the user's own subscription: a token
 * granted to the agent as a secret, or a login stored in the agent's home.
 */
import {
  HARNESSES,
  type AgentConfig,
  type Harness,
  type HarnessLogin,
  type HarnessLogins,
  type RecipeRole,
} from "../db/schema/index.js";

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
  antigravity: {
    harness: "antigravity",
    label: "Antigravity",
    secret: null,
    login: "agy, then sign in with Google",
  },
};

const HARNESS_SET = new Set<string>(HARNESSES);

/** Where the runtime image lists the harness CLIs it carries, one per line. */
export const HARNESS_LIST = "/usr/local/share/guilds/harnesses";

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && HARNESS_SET.has(value);
}

/** The harnesses the box turns off: still in the image, but not offered and not run. */
let harnessesOff = new Set<Harness>();

/** Sets the harnesses the box turns off, once at boot. */
export function installHarnessesOff(off: readonly Harness[]): void {
  harnessesOff = new Set(off);
}

export function isHarnessOff(harness: Harness): boolean {
  return harnessesOff.has(harness);
}

/** The harnesses the box offers, in their order. */
export function harnessesOn(): Harness[] {
  return HARNESSES.filter((harness) => !harnessesOff.has(harness));
}

/** The harnesses a subscription agent may run on. */
export const SUBSCRIPTION_HARNESSES: readonly Harness[] = ["claude-code", "codex"];

/** Whether a subscription agent may run on the harness. */
export function isSubscriptionHarness(harness: Harness): boolean {
  return SUBSCRIPTION_HARNESSES.includes(harness);
}

/** Why a subscription agent cannot run on a harness it may not run on. */
export function subscriptionHarnessMessage(harness: Harness): string {
  const offered = SUBSCRIPTION_HARNESSES.map((item) => HARNESS_INFO[item].label).join(" or ");
  return `${HARNESS_INFO[harness].label} cannot run a subscription agent: pick ${offered}, or give the agent a model`;
}

/** Whether the box offers subscription agents; it does not until boot installs the setting. */
let offersSubscriptionAgents = false;

/** Sets whether the box offers subscription agents, once at boot. */
export function installSubscriptionAgents(offered: boolean): void {
  offersSubscriptionAgents = offered;
}

export function areSubscriptionAgentsOn(): boolean {
  return offersSubscriptionAgents;
}

/** Why an agent cannot be created on, or switched to, a subscription while the box turns them off. */
export const SUBSCRIPTION_AGENTS_OFF_MESSAGE =
  "subscription agents are turned off on this box: give the agent a model on a key";

/** Why an agent cannot pick, or run on, a harness the box turns off. */
export function harnessOffMessage(harness: Harness): string {
  return `${HARNESS_INFO[harness].label} is turned off on this box: pick another harness in the agent's Settings`;
}

/** The harness an agent's config, or a recipe role's as its author wrote it, names; null when it names none. */
export function harnessOf(config: AgentConfig | RecipeRole["config"] | null | undefined): Harness | null {
  return isHarness(config?.harness) ? config.harness : null;
}

/**
 * A harness model name: an alias or a full model name, with the bracketed parameters some
 * harnesses take (`claude-opus-4-8[context=1m]`). The driver passes it as one argument.
 */
export const HARNESS_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/=,[\]-]{0,119}$/;

/** Whether a value is a harness model name. */
export function isHarnessModel(value: unknown): value is string {
  return typeof value === "string" && HARNESS_MODEL_RE.test(value);
}

/**
 * The model the harness of an agent's config, or of a recipe role's as its author wrote it, runs;
 * null leaves it to the harness's subscription.
 */
export function harnessModelOf(config: AgentConfig | RecipeRole["config"] | null | undefined): string | null {
  return isHarnessModel(config?.harness_model) ? config.harness_model : null;
}

/** The login record for a harness as stored, or none. */
export function harnessLoginOf(logins: HarnessLogins, harness: Harness): HarnessLogin {
  return logins[harness] ?? { seen_at: null, account: null };
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
export function credentialFix(harness: Harness, aliases: Record<string, string> = {}): string {
  const info = HARNESS_INFO[harness];
  const ways: string[] = [];
  const source = harnessSecretSource(harness, aliases);
  if (source !== null) {
    const as = source === info.secret ? "" : ` (read as ${info.secret})`;
    ways.push(`grant the secret ${source}${as} to the agent`);
  }
  ways.push(`log in from the agent's CLI tab with \`${info.login}\``);
  return ways.join(", or ");
}
