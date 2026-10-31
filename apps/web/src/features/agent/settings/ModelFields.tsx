import { useOrgModels } from "../../../api/queries/models";
import type { ThinkingLevel } from "../../../api/types/agents";
import { useIdentity } from "../../../app/identity";
import { Select, Slider } from "@guildsrun/ui";
import { modelLimits, modelOptions } from "../../models/models";
import { ModelKeysLink } from "../../models/ModelKeysLink";
import type { FieldsProps } from "./configForm";

const THINKING_LEVELS = ["none", "low", "medium", "high"] as const satisfies ThinkingLevel[];

/** Whether a value is a thinking level a model reasons at. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  const levels: readonly unknown[] = THINKING_LEVELS;
  return levels.includes(value);
}

function modelFieldMessage(message: string) {
  const match = /^Connect a (.+) key on Model keys first\.$/.exec(message);
  if (match) {
    return (
      <>
        Connect a {match[1]} key on <ModelKeysLink /> first.
      </>
    );
  }
  return message;
}

/** Model, thinking and temperature; what the chosen model does not take is switched off. */
export function ModelFields({ form, onChange, errors }: FieldsProps) {
  const { org } = useIdentity();
  const models = useOrgModels(org.id);
  const { thinkingOff, temperatureOff } = modelLimits(models.data, form.model);
  const codingConnected = models.data?.providers.some(
    (item) => item.kind === "coding" && item.connected,
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Select
        tone="surface"
        label="Model"
        placeholder="Choose a model"
        value={form.model}
        onValueChange={(value) => onChange({ model: value })}
        options={modelOptions(models.data, { current: form.model, coding: form.coding })}
        hint={
          form.coding && !codingConnected ? (
            <>
              Coding APIs appear here once a key is connected on <ModelKeysLink />.
            </>
          ) : undefined
        }
        {...(errors.model
          ? { error: modelFieldMessage(errors.model) }
          : models.isError
            ? { error: `Couldn't load the models: ${models.error.message}` }
            : {})}
      />
      <Select
        tone="surface"
        label="Thinking"
        hint={
          thinkingOff
            ? "This model does not reason before replying."
            : "Reasoning effort, for models that support it."
        }
        value={thinkingOff ? "none" : form.thinking}
        disabled={thinkingOff}
        onValueChange={(value) => {
          if (isThinkingLevel(value)) onChange({ thinking: value });
        }}
        options={[
          { value: "none", label: "Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ]}
      />
      <Slider
        label="Temperature"
        min={0}
        max={2}
        step={0.1}
        disabled={temperatureOff}
        hint={temperatureOff ? "This model sets its own temperature." : undefined}
        value={Number.isFinite(Number(form.temperature)) ? Number(form.temperature) : 1}
        onValueChange={(value) => onChange({ temperature: String(value) })}
        {...(errors.temperature ? { error: errors.temperature } : {})}
      />
    </div>
  );
}
