import { Bookmark, Code2, FileCode, Globe, type LucideIcon } from "lucide-react";
import type { Machine } from "../../../api/types/agents";
import type { OrgModels } from "../../../api/types/models";
import { cn, Icon } from "@guildsrun/ui";
import { agentMinimum, sizeMeets } from "../../machines/machines";
import { TooSmallNote } from "../../machines/MachineNotes";
import { BrowserFields, withBrowser } from "./BrowserFields";
import { withCoding, type ConfigErrors, type ConfigForm } from "./configForm";

type CapabilityFieldProps = {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: LucideIcon;
};

/** An on/off capability as a pressed button. */
function CapabilityField({ label, hint, checked, onChange, disabled, icon }: CapabilityFieldProps) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-full min-w-0 cursor-pointer flex-col items-start gap-1 rounded-xl bg-surface px-3.5 py-3 text-left transition-colors",
        "hover:bg-paper-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        "selected:bg-ink-fill selected:text-on-ink selected:hover:bg-ink-fill",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        {icon ? <Icon icon={icon} size={16} /> : null}
        {label}
      </span>
      <span className={cn("text-xs text-pretty", checked ? "opacity-80" : "text-muted")}>
        {hint}
      </span>
    </button>
  );
}

type CapabilitiesFieldsProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  models?: OrgModels | undefined;
  errors?: ConfigErrors;
  /** The machine the agent goes on; undefined while none is chosen. */
  machine?: Pick<Machine, "name" | "cpu" | "memory_mib"> | undefined;
  codingToggle?: boolean;
  /** Whether the saved agent codes, which keeps Coding on. */
  savedCoding?: boolean;
};

/**
 * Browser, Coding, scripting, and Memory. Every agent has the CLI, so it has no card. Browser and
 * Coding are greyed out while off when the machine is below the minimum they would set, with a
 * line that points to Settings → Machines; Coding stays on once saved: a coding agent stays one.
 * `codingToggle` false leaves the Coding card out, where the kind of agent was chosen before the form.
 * With the browser on, its settings follow the cards.
 */
export function CapabilitiesFields({
  form,
  onChange,
  models,
  errors = {},
  machine,
  codingToggle = true,
  savedCoding = false,
}: CapabilitiesFieldsProps) {
  const browserMinimum = agentMinimum({ browser: true, coding: form.coding });
  const codingMinimum = agentMinimum({ browser: form.browser, coding: true });
  const browserBlocked =
    !form.browser && machine !== undefined && !sizeMeets(machine, browserMinimum);
  const codingBlocked =
    codingToggle && !form.coding && machine !== undefined && !sizeMeets(machine, codingMinimum);
  return (
    <>
      <div
        className={cn("grid grid-cols-2 gap-2", codingToggle ? "sm:grid-cols-4" : "sm:grid-cols-3")}
      >
        <CapabilityField
          label="Browser"
          hint="Browser tab and tools. Uses a browser slot."
          icon={Globe}
          checked={form.browser}
          disabled={browserBlocked}
          onChange={(browser) => onChange(withBrowser(form, browser))}
        />
        {codingToggle ? (
          <CapabilityField
            label="Coding"
            hint={
              savedCoding
                ? "Shell, and a harness for code work. A coding agent stays one."
                : "Shell, and a harness for code work. Turns on scripting. Uses a coding slot."
            }
            icon={Code2}
            checked={form.coding}
            disabled={savedCoding || codingBlocked}
            onChange={(coding) => onChange(withCoding(form, coding, models))}
          />
        ) : null}
        <CapabilityField
          label="Scripting"
          hint="The Scripts tab and the script tools."
          icon={FileCode}
          checked={form.scripting}
          onChange={(scripting) => onChange({ ...form, scripting })}
        />
        <CapabilityField
          label="Memory"
          hint="One Markdown file the agent rewrites to remember across runs."
          icon={Bookmark}
          checked={form.memory}
          onChange={(memory) => onChange({ ...form, memory })}
        />
      </div>
      {machine && codingBlocked ? (
        <TooSmallNote machine={machine} minimum={codingMinimum} what="Coding" />
      ) : machine && browserBlocked ? (
        <TooSmallNote machine={machine} minimum={browserMinimum} what="Browser" />
      ) : null}
      {form.browser ? (
        <BrowserFields form={form} onChange={onChange} models={models} errors={errors} />
      ) : null}
    </>
  );
}
