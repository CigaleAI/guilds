import { useHarnessCatalog } from "../../../api/queries/agents";
import type { ModelSource } from "../../../api/types/agents";
import { Segmented, type SegmentedOption } from "@guildsrun/ui";
import { withModelSource, type ConfigForm } from "./configForm";

const OPTIONS: SegmentedOption<ModelSource>[] = [
  { value: "key", label: "Model on a key" },
  { value: "subscription", label: "Subscription" },
];

type ModelSourceFieldProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
};

/**
 * Whether the agent runs on a model on one of the organisation's keys, or on its harness on the
 * operator's own subscription.
 */
export function ModelSourceField({ form, onChange }: ModelSourceFieldProps) {
  const catalog = useHarnessCatalog();
  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        label="Model source"
        value={form.model_source}
        onValueChange={(source) => onChange(withModelSource(form, source, catalog.data))}
        options={OPTIONS}
      />
      <p className="text-xs text-muted">
        {form.model_source === "subscription"
          ? "The harness runs every turn on your own subscription, with its own tools and the guild's tools this agent is given."
          : "A model on one of the organisation's keys runs every turn."}
      </p>
    </div>
  );
}
