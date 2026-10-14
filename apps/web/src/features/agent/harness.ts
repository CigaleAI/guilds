import type { AgentHarness, Harness, HarnessCredential, Secret } from "../../api/types";
import { relativeTime } from "../../app/format";

/** Each harness's name as the app shows it. */
export const harnessLabels: Readonly<Record<Harness, string>> = Object.freeze({
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
});

/** The harnesses a coding agent can run, as select options. */
export const harnessOptions = (Object.keys(harnessLabels) as Harness[]).map((harness) => ({
  value: harness,
  label: harnessLabels[harness],
}));

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && Object.hasOwn(harnessLabels, value);
}

/** A harness's label; the value itself when the app does not know it. */
export function harnessLabel(value: unknown): string {
  return isHarness(value) ? harnessLabels[value] : String(value ?? "");
}

/** Why a harness can be missing from a machine, shown wherever the image decides what can run. */
export const harnessImageNote =
  "A published image carries Codex only; Claude Code and Cursor need an image built with them.";

/** What a harness runs on, and the vendor-terms risk that comes with it; shown wherever a harness is chosen. */
export const harnessSubscriptionNote =
  "The harness does the code work on your own subscription. Using a personal subscription in a shared organisation may fall outside the vendor's terms.";

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

/** What the Harness model field suggests and says for each harness; any model the subscription offers works. */
export const harnessModelHelp: Readonly<
  Record<Harness, { suggestions: readonly string[]; hint: string }>
> = Object.freeze({
  "claude-code": {
    suggestions: ["fable", "opus", "sonnet", "haiku"],
    hint: "An alias for the latest model, or a full model name.",
  },
  codex: { suggestions: [], hint: "A model name your ChatGPT plan offers." },
  cursor: {
    suggestions: [],
    hint: "A model name; agent models in the CLI tab lists your account's.",
  },
});

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

/** One segment of the coding strip: its text, whether it flags a problem, and where it leads. */
export type StripSegment = { text: string; problem: boolean; to: "settings" | "repositories" };

/** What a coding agent's chat strip reads from: the harness status, the lead model's label, and the agent's secrets. */
export type StripInput = {
  status: AgentHarness;
  leadModel: string;
  secrets: readonly TokenSecret[];
  now: Date;
};

function harnessSegment(status: AgentHarness, harness: Harness): StripSegment {
  const label = harnessLabels[harness];
  if (harnessCarried(status.machine_harnesses, harness) === false) {
    return { text: `${label} is not in this machine's image`, problem: true, to: "settings" };
  }
  const model = status.harness_model ?? "default model";
  return { text: `${label} · ${model} codes`, problem: false, to: "settings" };
}

/** Whose secret the harness runs on: who added it, when the agent's secrets say. */
function secretSegment(entry: HarnessCredential, secrets: readonly TokenSecret[]): StripSegment {
  const by = secrets.find((secret) => secret.name === entry.secret_source)?.created_by?.name;
  const suffix = by ? `, added by ${by}` : "";
  return { text: `on ${entry.secret_source}${suffix}`, problem: false, to: "settings" };
}

function loginSegment(entry: HarnessCredential, now: Date): StripSegment {
  const who = entry.login_account ? ` as ${entry.login_account}` : "";
  const seen = entry.login_seen_at ? `, seen ${relativeTime(entry.login_seen_at, now)}` : "";
  return { text: `on its login${who}${seen}`, problem: false, to: "settings" };
}

function credentialSegment(entry: HarnessCredential | undefined, input: StripInput): StripSegment {
  if (entry?.secret_granted) return secretSegment(entry, input.secrets);
  if (entry?.login_seen_at) return loginSegment(entry, input.now);
  return { text: "no credential", problem: true, to: "settings" };
}

function repositoriesSegment(repositories: readonly string[]): StripSegment {
  return repositories.length
    ? { text: `repos ${repositories.join(", ")}`, problem: false, to: "repositories" }
    : { text: "no repositories", problem: true, to: "repositories" };
}

/** Which harness and model code and what the harness runs on; one problem segment when none is picked. */
function harnessSegments(input: StripInput): StripSegment[] {
  const { status } = input;
  if (status.harness === null) return [{ text: "no harness picked", problem: true, to: "settings" }];
  const entry = status.harnesses.find((item) => item.harness === status.harness);
  return [harnessSegment(status, status.harness), credentialSegment(entry, input)];
}

/**
 * The chat strip of a coding agent: which model leads, which harness and model code, what the
 * harness runs on, and the repositories; a problem segment names what is missing.
 */
export function codingStrip(input: StripInput): StripSegment[] {
  return [
    { text: `${input.leadModel} leads`, problem: false, to: "settings" },
    ...harnessSegments(input),
    repositoriesSegment(input.status.repositories),
  ];
}

/** What a new coding agent's token step holds: a secret picked among the guild's, or a token pasted. */
export type TokenDraft = { secret: string; pasted: string };

/**
 * How a new agent gets its harness token: the aliases its config starts with, and the secret to
 * add for it once it exists (its name, granted to the agent alone), when a token was pasted. A
 * pasted token takes the variable's name, or the agent's on it when a secret of that name already
 * reaches the guild.
 */
export function tokenPlan(input: {
  variable: string | undefined;
  draft: TokenDraft;
  agentName: string;
  guildSecrets: readonly TokenSecret[];
}): { aliases: Record<string, string>; add: string | null } {
  const { variable, draft } = input;
  if (!variable) return { aliases: {}, add: null };
  if (draft.pasted.trim()) {
    const name = freeTokenName(variable, input.agentName, input.guildSecrets);
    return { aliases: withTokenAlias({}, variable, name), add: name };
  }
  return { aliases: withTokenAlias({}, variable, draft.secret), add: null };
}
