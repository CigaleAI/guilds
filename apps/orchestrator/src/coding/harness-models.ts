import { HARNESS_INFO, HARNESSES, type Harness } from "./harnesses.js";

/** The reasoning efforts a harness can run a model at, lowest first. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

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
   * The CLI's model name for each effort, for a harness that names a model and its effort
   * together (Cursor). Without it the id is the CLI's model name and the effort goes apart.
   */
  ids?: Partial<Record<Effort, string>>;
};

const LOW_TO_MAX: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A model that takes its effort apart from its name. */
function model(id: string, label: string, efforts: readonly Effort[], defaultEffort: Effort | null): HarnessModel {
  return { id, label, efforts, default_effort: defaultEffort };
}

/** A Cursor model whose CLI name for each effort is `<prefix>-<effort>`. */
function cursorModel(
  names: { id: string; label: string; prefix: string },
  efforts: readonly Effort[],
  defaultEffort: Effort,
): HarnessModel {
  const ids = Object.fromEntries(efforts.map((effort) => [effort, `${names.prefix}-${effort}`]));
  return { id: names.id, label: names.label, efforts, default_effort: defaultEffort, ids };
}

/** The models Settings lists for each harness. Any other model name still runs, as a custom one. */
export const HARNESS_MODELS: Readonly<Record<Harness, readonly HarnessModel[]>> = {
  "claude-code": [
    model("fable", "Fable", LOW_TO_MAX, null),
    model("opus", "Opus", LOW_TO_MAX, null),
    model("sonnet", "Sonnet", LOW_TO_MAX, null),
    model("haiku", "Haiku", LOW_TO_MAX, null),
  ],
  codex: [
    model("gpt-6-luna", "GPT-6-Luna", LOW_TO_MAX, "medium"),
    model("gpt-5.6-terra", "GPT-5.6-Terra", [...LOW_TO_MAX, "ultra"], "medium"),
    model("gpt-5.6-luna", "GPT-5.6-Luna", LOW_TO_MAX, "medium"),
  ],
  cursor: [
    cursorModel({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", prefix: "gpt-5.6-sol" }, ["none", ...LOW_TO_MAX], "medium"),
    cursorModel({ id: "gpt-5.6-terra", label: "GPT-5.6 Terra", prefix: "gpt-5.6-terra" }, ["none", ...LOW_TO_MAX], "medium"),
    cursorModel({ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", prefix: "gpt-5.6-luna" }, ["none", ...LOW_TO_MAX], "medium"),
    cursorModel({ id: "claude-fable-5-1", label: "Claude Fable 5.1", prefix: "claude-fable-5-1" }, LOW_TO_MAX, "high"),
    cursorModel(
      { id: "claude-fable-5-1-thinking", label: "Claude Fable 5.1 Thinking", prefix: "claude-fable-5-1-thinking" },
      LOW_TO_MAX,
      "high",
    ),
    cursorModel({ id: "claude-opus-5-5", label: "Claude Opus 5.5", prefix: "claude-opus-5-5" }, LOW_TO_MAX, "medium"),
    cursorModel({ id: "grok-4.7", label: "Grok 4.7", prefix: "grok-4.7" }, ["low", "medium", "high", "xhigh"], "medium"),
    model("composer-2.5", "Composer 2.5", [], null),
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

/** The effort the agent's harness runs at; null leaves it to the harness. */
export function harnessEffortOf(config: Record<string, unknown> | null | undefined): Effort | null {
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
  models: { id: string; label: string; efforts: readonly Effort[]; default_effort: Effort | null }[];
  unlisted_efforts: readonly Effort[];
};

/** Every harness's listed models, without the CLI names they start under. */
export function harnessCatalog(): HarnessCatalog[] {
  return HARNESSES.map((harness) => ({
    harness,
    label: HARNESS_INFO[harness].label,
    models: HARNESS_MODELS[harness].map(({ id, label, efforts, default_effort }) => ({ id, label, efforts, default_effort })),
    unlisted_efforts: UNLISTED_EFFORTS[harness],
  }));
}
