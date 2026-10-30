import { TextField } from "@guildsrun/ui";
import { limitFields, type FieldsProps } from "./configForm";

export function LimitFields({ form, onChange, errors }: FieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {limitFields.map((field) => (
        <TextField
          key={field.key}
          tone="surface"
          label={field.label}
          type="number"
          min={1}
          step={1}
          hint={field.hint}
          value={form[field.key]}
          onChange={(event) => onChange({ [field.key]: event.currentTarget.value })}
          {...(errors[field.key] ? { error: errors[field.key] } : {})}
        />
      ))}
    </div>
  );
}

/** The agent home's disk cap, in MiB. */
export function MaxDiskField({ form, onChange, errors }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max disk"
      type="number"
      min={1}
      step={1}
      hint="MiB the agent's home may hold. A generation will not start while the home is over this, or while its machine is over the machine's cap. 10240 is 10 GiB."
      value={form.max_workspace_mib}
      onChange={(event) => onChange({ max_workspace_mib: event.currentTarget.value })}
      {...(errors.max_workspace_mib ? { error: errors.max_workspace_mib } : {})}
    />
  );
}

/** How many scripts the agent may keep. */
export function MaxScriptsField({ form, onChange, errors }: FieldsProps) {
  return (
    <TextField
      tone="surface"
      label="Max scripts"
      type="number"
      min={1}
      step={1}
      hint="Reusable Python files this agent may keep. Creating another is refused past this number."
      value={form.max_scripts}
      onChange={(event) => onChange({ max_scripts: event.currentTarget.value })}
      {...(errors.max_scripts ? { error: errors.max_scripts } : {})}
    />
  );
}

/** The agent home's disk cap, in MiB, beside how many scripts the agent may keep. */
export function DiskFields(props: FieldsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <MaxDiskField {...props} />
      <MaxScriptsField {...props} />
    </div>
  );
}
