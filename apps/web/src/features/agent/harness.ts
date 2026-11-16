import type {
  AgentHarness,
  Harness,
  HarnessCatalog,
  HarnessCatalogModel,
  HarnessCredential,
  HarnessEffort,
} from "../../api/types/agents";
import type { Secret } from "../../api/types/secrets";

/** Each harness's name as the app shows it. */
export const harnessLabels: Readonly<Record<Harness, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
});

/** The harnesses a subscription agent can run, as select options. */
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

/** A harness's label; empty when none is named. */
export function harnessLabel(harness: Harness | null | undefined): string {
  return harness ? harnessLabels[harness] : "";
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

/** Why a subscription agent's harness cannot run yet. */
export type HarnessProblem =
  | { kind: "harness" }
  | { kind: "credential"; label: string }
  | { kind: "image"; label: string };

/** The harness's credential: a granted secret, or a login a check last found. */
function hasCredential(entry: HarnessCredential | undefined): boolean {
  return Boolean(entry?.secret_granted || entry?.login_seen_at);
}

/** What the picked harness lacks: its CLI in the machine's image, or a credential. */
function pickedHarnessProblems(status: AgentHarness, harness: Harness): HarnessProblem[] {
  const label = harnessLabels[harness];
  const entry = status.harnesses.find((item) => item.harness === harness);
  const problems: HarnessProblem[] = [];
  if (harnessCarried(status.machine_harnesses, harness) === false)
    problems.push({ kind: "image", label });
  if (!hasCredential(entry)) problems.push({ kind: "credential", label });
  return problems;
}

/**
 * What stands between an agent and its harness running: no harness picked, a machine image
 * without the harness's CLI, or a harness without a credential. Empty when nothing does.
 */
export function harnessProblems(status: AgentHarness): HarnessProblem[] {
  return status.harness === null
    ? [{ kind: "harness" }]
    : pickedHarnessProblems(status, status.harness);
}

function problemText(problem: HarnessProblem): string {
  switch (problem.kind) {
    case "harness":
      return "no harness is picked";
    case "image":
      return `this machine's image doesn't carry ${problem.label}`;
    default:
      return `${problem.label} has no credential`;
  }
}

function problemsClause(problems: readonly HarnessProblem[]): string {
  return problems.map(problemText).join("; ");
}

/** Every problem as one sentence, for the Settings banner on a subscription that isn't ready. */
export function harnessProblemsSentence(problems: readonly HarnessProblem[]): string {
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

/**
 * Whether a subscription agent on a harness needs a repository, as the catalogue says; none does
 * before the catalogue loads, and the server still refuses one without.
 */
export function needsRepository(
  catalog: readonly HarnessCatalog[] | undefined,
  harness: Harness,
): boolean {
  return catalogFor(catalog, harness)?.needs_repository === true;
}

/** Why a subscription agent cannot run on `harnesses`, which need a repository, while it picks none. */
export function missingRepositoryText(harnesses: readonly Harness[]): string {
  const names = harnesses.map((harness) => harnessLabels[harness]).join(" and ");
  return harnesses.length === 1
    ? `${names} keeps its own system prompt, so it runs a subscription agent only with a repository.`
    : `${names} keep their own system prompt, so they run a subscription agent only with a repository.`;
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
