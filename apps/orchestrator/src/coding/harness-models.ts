import { HARNESSES, type Harness } from "../db/schema/index.js";
import { HARNESS_INFO, harnessNeedsRepository, isHarnessOff } from "./harnesses.js";
import { EFFORTS, type AgentConfig, type Effort, type RecipeRole } from "../db/schema/index.js";


const EFFORT_SET = new Set<string>(EFFORTS);

/** One model a harness offers, as Settings lists it. */
export type HarnessModel = {
  /** What the agent's `harness_model` stores. */
  id: string;
  label: string;
  /** The efforts the model runs at; empty when it takes none. */
  efforts: readonly Effort[];
  /** The effort a run gets without one set; null leaves it to the harness. */
  default_effort: Effort | null;
  /**
   * The CLI's model name for each effort, for a model the CLI names together with its effort
   * (Cursor's, and Antigravity's listed ones). Without it the id is the CLI's model name and the
   * effort goes apart.
   */
  ids?: Partial<Record<Effort, string>>;
};

const LOW_TO_MAX: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A model that takes its effort apart from its name. */
function model(id: string, label: string, efforts: readonly Effort[], defaultEffort: Effort | null): HarnessModel {
  return { id, label, efforts, default_effort: defaultEffort };
}

/** A model whose CLI name carries its effort: `<id>-<effort>` for each effort it runs at. */
function effortNamedModel(id: string, label: string, efforts: readonly Effort[], defaultEffort: Effort): HarnessModel {
  const ids = Object.fromEntries(efforts.map((effort) => [effort, `${id}-${effort}`]));
  return { id, label, efforts, default_effort: defaultEffort, ids };
}

const LOW_TO_HIGH: readonly Effort[] = ["low", "medium", "high"];
const LOW_TO_XHIGH: readonly Effort[] = [...LOW_TO_HIGH, "xhigh"];
const LOW_TO_ULTRA: readonly Effort[] = [...LOW_TO_MAX, "ultra"];
const NONE_TO_MAX: readonly Effort[] = ["none", ...LOW_TO_MAX];

/** The models Settings lists for each harness. Any other model name still runs, as a custom one. */
export const HARNESS_MODELS: Readonly<Record<Harness, readonly HarnessModel[]>> = {
  "claude-code": [
    model("fable", "Fable", LOW_TO_MAX, null),
    model("opus", "Opus", LOW_TO_MAX, null),
    model("sonnet", "Sonnet", LOW_TO_MAX, null),
    model("haiku", "Haiku", LOW_TO_MAX, null),
  ],
  codex: [
    model("gpt-6.2-sol", "GPT-6.2-Sol", LOW_TO_ULTRA, "low"),
    model("gpt-6.2-astra", "GPT-6.2-Astra", LOW_TO_ULTRA, "low"),
    model("gpt-6.1-terra", "GPT-6.1-Terra", LOW_TO_ULTRA, "low"),
    model("gpt-6-luna", "GPT-6-Luna", LOW_TO_MAX, "medium"),
  ],
  cursor: [
    effortNamedModel("gpt-5.6-sol", "GPT-5.6 Sol", NONE_TO_MAX, "medium"),
    effortNamedModel("gpt-5.6-terra", "GPT-5.6 Terra", NONE_TO_MAX, "medium"),
    effortNamedModel("gpt-5.6-luna", "GPT-5.6 Luna", NONE_TO_MAX, "medium"),
    effortNamedModel("claude-fable-5-2", "Claude Fable 5.2", LOW_TO_MAX, "high"),
    effortNamedModel("claude-opus-5-5", "Claude Opus 5.5", LOW_TO_MAX, "medium"),
    effortNamedModel("claude-sonnet-5-5", "Claude Sonnet 5.5", LOW_TO_MAX, "medium"),
    effortNamedModel("grok-4.7", "Grok 4.7", LOW_TO_XHIGH, "medium"),
    model("composer-2.5", "Composer 2.5", [], null),
  ],
  antigravity: [
    effortNamedModel("gemini-4-hydrogen", "Gemini 4 Hydrogen", LOW_TO_XHIGH, "medium"),
    effortNamedModel("gemini-4-argon", "Gemini 4 Argon", LOW_TO_HIGH, "medium"),
    effortNamedModel("gemini-3.8-flash", "Gemini 3.8 Flash", LOW_TO_HIGH, "medium"),
    effortNamedModel("claude-opus-5-5", "Claude Opus 5.5", LOW_TO_HIGH, "medium"),
    effortNamedModel("claude-sonnet-5-5", "Claude Sonnet 5.5", LOW_TO_HIGH, "medium"),
  ],
};

/**
 * The efforts a harness takes for a model it does not list, or for its subscription's default
 * model. Cursor takes none: its model names carry their effort.
 */
const UNLISTED_EFFORTS: Readonly<Record<Harness, readonly Effort[]>> = {
  "claude-code": LOW_TO_MAX,
  codex: EFFORTS,
  cursor: [],
  antigravity: LOW_TO_MAX,
};

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORT_SET.has(value);
}

/** The listed model of that id, or null for a custom model name. */
export function findHarnessModel(harness: Harness, id: string | null): HarnessModel | null {
  return HARNESS_MODELS[harness].find((entry) => entry.id === id) ?? null;
}

/** The efforts a harness runs a model at: the listed model's, else what it takes for any other. */
export function harnessEffortsFor(harness: Harness, modelId: string | null): readonly Effort[] {
  return findHarnessModel(harness, modelId)?.efforts ?? UNLISTED_EFFORTS[harness];
}

/** The effort the harness of an agent's config, or of a recipe role's as its author wrote it, runs at; null leaves it to the harness. */
export function harnessEffortOf(config: AgentConfig | RecipeRole["config"] | null | undefined): Effort | null {
  return isEffort(config?.harness_effort) ? config.harness_effort : null;
}

/** Whether the harness takes an effort apart from the model name; Cursor's names carry it. */
function takesEffortApart(harness: Harness): boolean {
  return UNLISTED_EFFORTS[harness].length > 0;
}

/** What the harness CLI is started with: its model name and its effort, each null to pass none. */
export type HarnessLaunch = { model: string | null; effort: Effort | null };

/** The CLI name of a listed model for the effort set, else for its default effort. */
function nameForEffort(listed: HarnessModel, ids: Partial<Record<Effort, string>>, effort: Effort | null): string {
  const chosen = effort !== null && effort in ids ? effort : listed.default_effort;
  return (chosen === null ? undefined : ids[chosen]) ?? listed.id;
}

/**
 * The CLI's model name and effort for the agent's settings. A model listed with a name per effort
 * starts under the name for its effort, and a harness whose names carry the effort gets none apart.
 */
export function harnessLaunch(harness: Harness, modelId: string | null, effort: Effort | null): HarnessLaunch {
  const listed = findHarnessModel(harness, modelId);
  if (listed?.ids) {
    return { model: nameForEffort(listed, listed.ids, effort), effort: null };
  }
  return { model: modelId, effort: takesEffortApart(harness) ? effort : null };
}

/** One harness as Settings offers it: its listed models, and the efforts any other model takes. */
export type HarnessCatalog = {
  harness: Harness;
  label: string;
  /** False when the box turns the harness off: Settings offers it only to an agent already on it. */
  enabled: boolean;
  /** Whether a subscription agent on the harness needs a repository. */
  needs_repository: boolean;
  models: { id: string; label: string; efforts: readonly Effort[]; default_effort: Effort | null }[];
  unlisted_efforts: readonly Effort[];
};

/** Every harness's listed models, without the CLI names they start under. */
export function harnessCatalog(): HarnessCatalog[] {
  return HARNESSES.map((harness) => ({
    harness,
    label: HARNESS_INFO[harness].label,
    enabled: !isHarnessOff(harness),
    needs_repository: harnessNeedsRepository(harness),
    models: HARNESS_MODELS[harness].map(({ id, label, efforts, default_effort }) => ({ id, label, efforts, default_effort })),
    unlisted_efforts: UNLISTED_EFFORTS[harness],
  }));
}

/** The harnesses the box offers. */
export type HarnessOffer = { harnesses: HarnessCatalog[] };

/** What Settings and the create flow offer: every harness's catalog. */
export function harnessOffer(): HarnessOffer {
  return { harnesses: harnessCatalog() };
}
