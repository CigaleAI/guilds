import type {
  AgentHarness,
  Harness,
  HarnessCatalog,
  HarnessCatalogModel,
  HarnessCredential,
  HarnessEffort,
} from "../../api/types/agents";
import type { Secret } from "../../api/types/secrets";
import { relativeTime } from "../../app/format";

/** Each harness's name as the app shows it. */
export const harnessLabels: Readonly<Record<Harness, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
});

/** The harnesses a coding agent can run, as select options. */
export const harnessOptions = Object.keys(harnessLabels)
  .filter(isHarness)
  .map((harness) => ({ value: harness, label: harnessLabels[harness] }));

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(harnessLabels, value);
}

/** Whether a value is a reasoning effort a harness runs a model at. */
export function isHarnessEffort(value: unknown): value is HarnessEffort {
  return typeof value === "string" && Object.hasOwn(effortLabels, value);
}

/** A harness's label; the value itself when the app does not know it. */
export function harnessLabel(value: unknown): string {
  return isHarness(value) ? harnessLabels[value] : String(value ?? "");
}

/** Why a harness can be missing from a machine, shown wherever the image decides what can run. */
export const harnessImageNote =
  "A published image carries Codex only; Claude Code, Cursor, and Antigravity need an image built with them.";

/** What a harness runs on; shown wherever a harness is chosen. */
export const harnessSubscriptionNote =
  "Tasks run on your own subscription. Ensure shared use complies with your vendor plan.";

/**
 * Whether a machine's image carries a harness's CLI: true or false once the machine has started
 * and reported its CLIs, null while that is unknown.
 */
export function harnessCarried(
  carried: readonly Harness[] | null | undefined,
  harness: Harness,
): boolean | null {
  return carried ? carried.includes(harness) : null;
}

/** The harness select's options on a machine: one its image lacks is shown unavailable. */
export function harnessChoices(carried: readonly Harness[] | null | undefined) {
  return harnessOptions.map((option) =>
    harnessCarried(carried, option.value) === false
      ? { ...option, disabled: true, description: "Not on this machine's image" }
      : option,
  );
}

/** Whether the select shows the image note: the machine's CLIs are unknown, or some are missing. */
export function showsHarnessImageNote(carried: readonly Harness[] | null | undefined): boolean {
  return !carried || harnessOptions.some((option) => !carried.includes(option.value));
}

/** Each effort's name as the app shows it. */
export const effortLabels: Readonly<Record<HarnessEffort, string>> = Object.freeze({
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
});

/** The harness's models and efforts in the catalogue; undefined until it loads. */
export function catalogFor(
  catalog: readonly HarnessCatalog[] | undefined,
  harness: Harness,
): HarnessCatalog | undefined {
  return catalog?.find((entry) => entry.harness === harness);
}

/** The listed model of that id; undefined for the subscription's default or a custom name. */
export function listedHarnessModel(
  entry: HarnessCatalog | undefined,
  model: string,
): HarnessCatalogModel | undefined {
  return entry?.models.find((item) => item.id === model);
}

/** The efforts the harness runs a model at: the listed model's, else what it takes for any other. */
export function harnessEffortsFor(
  entry: HarnessCatalog | undefined,
  model: string,
): readonly HarnessEffort[] {
  return listedHarnessModel(entry, model)?.efforts ?? entry?.unlisted_efforts ?? [];
}

/** What the effort select calls leaving the effort unset: the model's default, else the harness's. */
export function defaultEffortLabel(listed: HarnessCatalogModel | undefined): string {
  const effort = listed?.default_effort;
  return effort ? `Default (${effortLabels[effort]})` : "Harness default";
}

/** What the harness codes with: the model, and the effort once one is set. */
function harnessRunsWith(status: AgentHarness): string {
  const model = status.harness_model ?? "its default model";
  const effort = status.harness_effort;
  return effort ? `${model} at ${effortLabels[effort].toLowerCase()} effort` : model;
}

/** Why a coding agent's runs cannot delegate code work yet. */
export type CodingProblem =
  | { kind: "harness" }
  | { kind: "credential"; label: string }
  | { kind: "image"; label: string }
  | { kind: "repositories" };

/** The harness's credential: a granted secret, or a login a check last found. */
function hasCredential(entry: HarnessCredential | undefined): boolean {
  return Boolean(entry?.secret_granted || entry?.login_seen_at);
}

/** What the picked harness lacks: its CLI in the machine's image, or a credential. */
function pickedHarnessProblems(status: AgentHarness, harness: Harness): CodingProblem[] {
  const label = harnessLabels[harness];
  const entry = status.harnesses.find((item) => item.harness === harness);
  const problems: CodingProblem[] = [];
  if (harnessCarried(status.machine_harnesses, harness) === false)
    problems.push({ kind: "image", label });
  if (!hasCredential(entry)) problems.push({ kind: "credential", label });
  return problems;
}

/**
 * What stands between a coding agent and its first code task: no harness picked, a machine image
 * without the harness's CLI, a harness without a credential, or a guild without repositories.
 * Empty when nothing does.
 */
export function codingProblems(status: AgentHarness): CodingProblem[] {
  const harness: CodingProblem[] =
    status.harness === null ? [{ kind: "harness" }] : pickedHarnessProblems(status, status.harness);
  return status.repositories.length ? harness : [...harness, { kind: "repositories" }];
}

function problemText(problem: CodingProblem): string {
  switch (problem.kind) {
    case "harness":
      return "no harness is picked";
    case "image":
      return `this machine's image doesn't carry ${problem.label}`;
    case "credential":
      return `${problem.label} has no credential`;
    default:
      return "the guild has no repositories";
  }
}

function problemsClause(problems: readonly CodingProblem[]): string {
  return problems.map(problemText).join("; ");
}

/** One line naming every problem, for a warning that leads to Settings. */
export function codingProblemsText(problems: readonly CodingProblem[]): string {
  return `Coding isn't ready: ${problemsClause(problems)}. Fix it in Settings.`;
}

/** Every problem as one sentence, for the Settings banner titled Coding isn't ready. */
export function codingProblemsSentence(problems: readonly CodingProblem[]): string {
  const clause = problemsClause(problems);
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/** The variable each harness reads its subscription token from; none for a harness that only logs in. */
export const harnessSecrets: Readonly<Partial<Record<Harness, string>>> = Object.freeze({
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  cursor: "CURSOR_API_KEY",
});

/** What a new token secret for a harness says it is for, so the agent knows not to use it elsewhere. */
export const harnessTokenDescription: Readonly<Partial<Record<Harness, string>>> = Object.freeze({
  "claude-code":
    "Claude Code subscription token from claude setup-token, read by the coding harness.",
  cursor: "Cursor API key, read by the coding harness.",
});

/** The account a harness that only logs in runs on, as the create dialog names it. */
export const harnessLoginAccounts: Readonly<Partial<Record<Harness, string>>> = Object.freeze({
  codex: "your ChatGPT subscription",
  antigravity: "your Google account",
});

/**
 * Whether Settings offers a harness: one the box turns off only to an agent already on it.
 * Before the catalogue loads, every harness is offered.
 */
export function harnessOffered(
  catalog: readonly HarnessCatalog[] | undefined,
  harness: Harness,
  current: Harness | "",
): boolean {
  return catalogFor(catalog, harness)?.enabled !== false || harness === current;
}

/** The token picker's value for no alias: the variable's own secret, else a login. Not a secret name. */
export const NO_TOKEN_ALIAS = "-";

/** A secret as the token picker lists it: its name, and who added it. */
export type TokenSecret = Pick<Secret, "name" | "created_by">;

/** The option the picker shows for a secret: its name, and who added it when known. */
function tokenOption(secret: TokenSecret) {
  const by = secret.created_by?.name;
  return {
    value: secret.name,
    label: secret.name,
    ...(by ? { description: `Added by ${by}` } : {}),
  };
}

/**
 * The subscription token select's options for `variable`: the default first (the secret of the
 * variable's own name when one reaches the agent, else a login from the CLI tab), then every
 * other secret reaching the agent, by name.
 */
export function tokenOptions(variable: string, secrets: readonly TokenSecret[]) {
  const own = secrets.find((secret) => secret.name === variable);
  const fallback = own
    ? { ...tokenOption(own), value: NO_TOKEN_ALIAS, label: `${variable} (default)` }
    : { value: NO_TOKEN_ALIAS, label: "None: log in from the CLI tab" };
  const others = secrets.filter((secret) => secret.name !== variable).map(tokenOption);
  return [fallback, ...others];
}

/** The aliases with `variable` reading `secret`; `NO_TOKEN_ALIAS` or the variable's own name removes the alias. */
export function withTokenAlias(
  aliases: Record<string, string>,
  variable: string,
  secret: string,
): Record<string, string> {
  const { [variable]: _removed, ...rest } = aliases;
  return secret !== NO_TOKEN_ALIAS && secret !== variable ? { ...rest, [variable]: secret } : rest;
}

/** The name a new token secret for `variable` takes: the variable itself, else with the agent's name when taken. */
export function freeTokenName(
  variable: string,
  agentName: string,
  taken: readonly TokenSecret[],
): string {
  if (!taken.some((secret) => secret.name === variable)) return variable;
  return `${variable}_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** One part of the coding strip: what it reads, what hovering it adds, and whether it flags a problem. */
export type StripPart = { text: string; detail: string; problem: boolean };

/** The coding strip: the harness that codes (null before one is picked), what it runs on, and the repositories it clones. */
export type CodingStripState = {
  harness: Harness | null;
  harnessPart: StripPart;
  credential: StripPart | null;
  repositories: StripPart & { names: readonly string[] };
};

/** What a coding agent's chat strip reads from: the harness status and the agent's secrets. */
export type StripInput = {
  status: AgentHarness;
  secrets: readonly TokenSecret[];
  now: Date;
};

function harnessPart(status: AgentHarness, harness: Harness): StripPart {
  const label = harnessLabels[harness];
  if (harnessCarried(status.machine_harnesses, harness) === false) {
    return {
      text: `${label} is not in this machine's image`,
      detail: `Rebuild the machine's image with ${label}.`,
      problem: true,
    };
  }
  return {
    text: label,
    detail: `${label} codes with ${harnessRunsWith(status)}.`,
    problem: false,
  };
}

/** What the harness runs on: a granted token secret, the login found in the agent's home, or nothing. */
function credentialPart(entry: HarnessCredential | undefined, input: StripInput): StripPart {
  if (entry?.secret_granted && entry.secret_source) {
    const by = input.secrets.find((secret) => secret.name === entry.secret_source)?.created_by
      ?.name;
    return {
      text: `Token ${entry.secret_source}`,
      detail: `Runs on the secret ${entry.secret_source}${by ? `, added by ${by}` : ""}.`,
      problem: false,
    };
  }
  if (entry?.login_seen_at) {
    const who = entry.login_account ? ` as ${entry.login_account}` : "";
    return {
      text: "Logged in",
      detail: `Logged in${who}, seen ${relativeTime(entry.login_seen_at, input.now)}.`,
      problem: false,
    };
  }
  return {
    text: "Not logged in",
    detail: "No login in the agent's home and no token secret: log in from Settings.",
    problem: true,
  };
}

function repositoriesPart(names: readonly string[]): CodingStripState["repositories"] {
  return names.length
    ? {
        text: `${names.length} repo${names.length === 1 ? "" : "s"}`,
        detail: names.join(", "),
        problem: false,
        names,
      }
    : {
        text: "No repos",
        detail: "A coding run of a guild without repositories fails at start.",
        problem: true,
        names,
      };
}

/** The chat strip of a coding agent: its harness, whether that harness can sign in, and the repositories it reaches. */
export function codingStrip(input: StripInput): CodingStripState {
  const { status } = input;
  const repositories = repositoriesPart(status.repositories);
  if (status.harness === null) {
    return {
      harness: null,
      harnessPart: {
        text: "No harness picked",
        detail: "Pick the harness this agent codes through.",
        problem: true,
      },
      credential: null,
      repositories,
    };
  }
  const entry = status.harnesses.find((item) => item.harness === status.harness);
  return {
    harness: status.harness,
    harnessPart: harnessPart(status, status.harness),
    credential: credentialPart(entry, input),
    repositories,
  };
}

/** What a new coding agent's token step holds: a secret picked among the guild's, or a token pasted. */
export type TokenDraft = { secret: string; pasted: string };

/**
 * How a new agent gets its harness token: the aliases its config starts with, and the secret to
 * add for it once it exists (its name, granted to the agent alone), when a token was pasted. A
 * pasted token takes the variable's name, or the agent's on it when a secret of that name already
 * reaches the guild.
 */
export function tokenPlan(
  variable: string | undefined,
  draft: TokenDraft,
  agentName: string,
  guildSecrets: readonly TokenSecret[],
): { aliases: Record<string, string>; add: string | null } {
  if (!variable) return { aliases: {}, add: null };
  if (draft.pasted.trim()) {
    const name = freeTokenName(variable, agentName, guildSecrets);
    return { aliases: withTokenAlias({}, variable, name), add: name };
  }
  return { aliases: withTokenAlias({}, variable, draft.secret), add: null };
}
