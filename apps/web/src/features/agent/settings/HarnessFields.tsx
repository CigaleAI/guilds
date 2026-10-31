import { Check, Info } from "lucide-react";
import { useState } from "react";
import { useHarnessCatalog } from "../../../api/queries/agents";
import type { Harness, HarnessCatalog } from "../../../api/types/agents";
import { cn, Icon, Select, TextField } from "@guildsrun/ui";
import {
  catalogFor,
  defaultEffortLabel,
  effortLabels,
  harnessCarried,
  harnessEffortsFor,
  harnessImageNote,
  harnessLabel,
  harnessOffered,
  harnessSubscriptionNote,
  isHarnessEffort,
  listedHarnessModel,
  showsHarnessImageNote,
} from "../harness";
import { HarnessLogo } from "../HarnessLogo";
import {
  withHarnessModel,
  type ConfigErrors,
  type ConfigForm,
  type SettingsAgent,
} from "./configForm";
import { HarnessReadiness } from "./HarnessReadiness";

/** The model select's values for the subscription's default and for a name typed in. */
const DEFAULT_MODEL = "default";
const CUSTOM_MODEL = "custom";

type HarnessModelFieldsProps = {
  form: ConfigForm;
  harness: Harness;
  onChange: (next: ConfigForm) => void;
  error?: string | undefined;
};

/**
 * The model the picked harness runs, from its listed models, the subscription's default, or a
 * custom name typed in; then the effort it runs at, among the ones that model takes.
 */
function HarnessModelFields({ form, harness, onChange, error }: HarnessModelFieldsProps) {
  const catalog = useHarnessCatalog();
  const entry = catalogFor(catalog.data, harness);
  const model = form.harness_model.trim();
  const listed = listedHarnessModel(entry, model);
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || (model !== "" && !listed);
  const listedChoice = listed === undefined ? DEFAULT_MODEL : model;
  const pick = (value: string) => {
    setCustomPicked(value === CUSTOM_MODEL);
    if (value === CUSTOM_MODEL) return;
    onChange(withHarnessModel(form, value === DEFAULT_MODEL ? "" : value, catalog.data));
  };
  return (
    <>
      <Select
        tone="surface"
        label="Harness model"
        hint="Custom takes any model name the subscription offers."
        value={custom ? CUSTOM_MODEL : listedChoice}
        onValueChange={pick}
        options={[
          { value: DEFAULT_MODEL, label: "Subscription default" },
          ...(entry?.models ?? []).map((item) => ({
            value: item.id,
            label: item.label,
            description: item.id,
          })),
          { value: CUSTOM_MODEL, label: "Custom…" },
        ]}
      />
      {custom ? (
        <TextField
          tone="surface"
          label="Model name"
          placeholder="Subscription default"
          autoComplete="off"
          value={form.harness_model}
          onChange={(event) => {
            setCustomPicked(true);
            onChange(withHarnessModel(form, event.currentTarget.value, catalog.data));
          }}
          {...(error ? { error } : {})}
        />
      ) : null}
      <HarnessEffortField form={form} entry={entry} onChange={onChange} />
    </>
  );
}

/** The effort select's value for leaving the effort to the model's default. */
const DEFAULT_EFFORT = "default";

type HarnessEffortFieldProps = {
  form: ConfigForm;
  entry: HarnessCatalog | undefined;
  onChange: (next: ConfigForm) => void;
};

/**
 * The effort the harness runs its model at, among the ones the model takes; none is shown for a
 * model that takes none, such as a Cursor model whose name carries it.
 */
function HarnessEffortField({ form, entry, onChange }: HarnessEffortFieldProps) {
  const model = form.harness_model.trim();
  const efforts = harnessEffortsFor(entry, model);
  if (efforts.length === 0) return null;
  const offered = !form.harness_effort || efforts.includes(form.harness_effort);
  return (
    <Select
      tone="surface"
      label="Effort"
      hint="How hard the model reasons before it answers."
      value={form.harness_effort || DEFAULT_EFFORT}
      onValueChange={(value) => {
        if (value === DEFAULT_EFFORT) onChange({ ...form, harness_effort: "" });
        else if (isHarnessEffort(value)) onChange({ ...form, harness_effort: value });
      }}
      options={[
        { value: DEFAULT_EFFORT, label: defaultEffortLabel(listedHarnessModel(entry, model)) },
        ...efforts.map((effort) => ({ value: effort, label: effortLabels[effort] })),
      ]}
      {...(offered ? {} : { error: "This model doesn't run at that effort. Pick another." })}
    />
  );
}

const HARNESS_ITEMS = [
  { value: "claude-code" as const, label: "Claude Code", subtitle: "Anthropic" },
  { value: "codex" as const, label: "Codex", subtitle: "OpenAI" },
  { value: "cursor" as const, label: "Cursor", subtitle: "Cursor" },
  { value: "antigravity" as const, label: "Antigravity", subtitle: "Google" },
] as const;

type HarnessCardProps = {
  harness: Harness;
  label: string;
  subtitle: string;
  selected: boolean;
  available: boolean;
  /** The box turns it off; shown only while the agent is on it. */
  off: boolean;
  onPick: () => void;
};

function HarnessCard({
  harness,
  label,
  subtitle,
  selected,
  available,
  off,
  onPick,
}: HarnessCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!available}
      onClick={onPick}
      className={cn(
        "group relative flex flex-col items-start gap-2 rounded-xl border p-2.5 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        selected
          ? "border-focus/60 bg-paper-hi shadow-sm ring-2 ring-focus/80"
          : "border-line bg-surface hover:border-rule hover:bg-paper",
        !available && "cursor-not-allowed opacity-45 hover:border-line hover:bg-surface",
      )}
    >
      <div className="flex w-full items-center justify-between">
        <HarnessLogo harness={harness} size={28} />
        {selected ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-focus text-on-focus">
            <Icon icon={Check} size={14} />
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-semibold text-fg">{label}</span>
        <span className="text-xs text-muted">{subtitle}</span>
      </div>
      {!available || off ? (
        <span className="rounded bg-well px-1.5 py-0.5 text-2xs font-medium text-muted">
          {off ? "Turned off" : "Not on machine"}
        </span>
      ) : null}
    </button>
  );
}

type HarnessChoiceFieldsProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors: ConfigErrors;
  carried?: readonly Harness[] | null | undefined;
};

/**
 * A button with its logo for each harness the box offers and, once one is picked, its model and
 * effort. A harness the machine's image lacks is disabled with a note; one the box turns off shows
 * only while the agent is on it. Picking another harness clears the model and effort.
 */
export function HarnessChoiceFields({ form, onChange, errors, carried }: HarnessChoiceFieldsProps) {
  const pick = (value: Harness) =>
    onChange({
      ...form,
      harness: value,
      harness_model: value === form.harness ? form.harness_model : "",
      harness_effort: value === form.harness ? form.harness_effort : "",
    });
  const catalog = useHarnessCatalog();
  const items = HARNESS_ITEMS.filter((item) =>
    harnessOffered(catalog.data, item.value, form.harness),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-semibold text-fg">Harness</label>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="radiogroup"
          aria-label="Coding harness"
        >
          {items.map((item) => (
            <HarnessCard
              key={item.value}
              harness={item.value}
              label={item.label}
              subtitle={item.subtitle}
              selected={form.harness === item.value}
              available={harnessCarried(carried, item.value) !== false}
              off={catalogFor(catalog.data, item.value)?.enabled === false}
              onPick={() => pick(item.value)}
            />
          ))}
        </div>
        {errors.harness ? <span className="text-xs text-error">{errors.harness}</span> : null}
      </div>
      {form.harness ? (
        <HarnessModelFields
          key={form.harness}
          form={form}
          harness={form.harness}
          onChange={onChange}
          error={errors.harness_model}
        />
      ) : null}
    </div>
  );
}

type HarnessFieldProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  errors: ConfigErrors;
  agent?: SettingsAgent | undefined;
  carried?: readonly Harness[] | null | undefined;
};

/**
 * The coding agent's harness and the model it runs, with a note that it runs on the operator's own
 * subscription; for an existing agent, what its code tasks still need under it.
 */
export function HarnessField({ form, onChange, errors, agent, carried }: HarnessFieldProps) {
  const missing = form.harness ? harnessCarried(carried, form.harness) === false : false;
  return (
    <div className="flex flex-col gap-3">
      <HarnessChoiceFields form={form} onChange={onChange} errors={errors} carried={carried} />
      {missing ? (
        <p className="text-sm text-t-ochre-fg">
          This machine&apos;s image doesn&apos;t carry {harnessLabel(form.harness)}, so its code
          tasks fail. Pick another harness, or move the agent to a machine that has it.
        </p>
      ) : agent && form.harness ? (
        <HarnessReadiness
          agent={agent}
          harness={form.harness}
          aliases={form.secret_aliases}
          onAliasesChange={(secret_aliases) => onChange({ ...form, secret_aliases })}
        />
      ) : null}
      {showsHarnessImageNote(carried) ? (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Icon icon={Info} size={14} className="shrink-0" />
          <span>{harnessImageNote}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Icon icon={Info} size={14} className="shrink-0" />
        <span>{harnessSubscriptionNote}</span>
      </div>
    </div>
  );
}
