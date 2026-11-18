import { Bookmark, FileCode, Globe, type LucideIcon } from "lucide-react";
import type { Machine } from "../../../api/types/agents";
import type { OrgModels } from "../../../api/types/models";
import { cn, Icon } from "@guildsrun/ui";
import { agentMinimum, sizeMeets, type MachineSize } from "../../machines/machines";
import { TooSmallNote } from "../../machines/MachineNotes";
import { BrowserFields, withBrowser } from "./BrowserFields";
import { takesHarness, type ConfigErrors, type ConfigForm } from "./configForm";

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

/** The Browser capability, off today, when the chosen machine is below the minimum it would set, with that minimum. */
export type BlockedCapability = { what: "Browser"; minimum: MachineSize };

/** The Browser capability when the chosen machine is too small to turn it on; none before a machine is chosen. */
export function blockedCapabilities(form: ConfigForm, machine: MachineSize | undefined): BlockedCapability[] {
  if (!machine) return [];
  const browser = agentMinimum({ browser: true, model_source: form.model_source });
  return !form.browser && !sizeMeets(machine, browser) ? [{ what: "Browser", minimum: browser }] : [];
}

type CapabilitiesFieldsProps = {
  form: ConfigForm;
  onChange: (next: ConfigForm) => void;
  models?: OrgModels | undefined;
  errors?: ConfigErrors;
  /** The machine the agent goes on; undefined while none is chosen. */
  machine?: Pick<Machine, "name" | "cpu" | "memory_mib"> | undefined;
};

/**
 * Browser, scripting, and Memory. Every agent has the CLI, so it has no card. A subscription agent
 * has no scripting, so it has no card for it. Browser is greyed
 * out while off when the machine is below the minimum it would set, with a line that points to
 * Settings → Machines. With the browser on, its settings follow the cards.
 */
export function CapabilitiesFields({
  form,
  onChange,
  models,
  errors = {},
  machine,
}: CapabilitiesFieldsProps) {
  const blocked = blockedCapabilities(form, machine);
  const isBlocked = (what: BlockedCapability["what"]) => blocked.some((item) => item.what === what);
  const [first] = blocked;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <CapabilityField
          label="Browser"
          hint="Browser tab and tools. Uses a browser slot."
          icon={Globe}
          checked={form.browser}
          disabled={isBlocked("Browser")}
          onChange={(browser) => onChange(withBrowser(form, browser))}
        />
        {takesHarness(form) ? null : (
          <CapabilityField
            label="Scripting"
            hint="The Scripts tab and the script tools."
            icon={FileCode}
            checked={form.scripting}
            onChange={(scripting) => onChange({ ...form, scripting })}
          />
        )}
        <CapabilityField
          label="Memory"
          hint="One Markdown file the agent rewrites to remember across runs."
          icon={Bookmark}
          checked={form.memory}
          onChange={(memory) => onChange({ ...form, memory })}
        />
      </div>
      {machine && first ? (
        <TooSmallNote machine={machine} minimum={first.minimum} what={first.what} />
      ) : null}
      {form.browser ? (
        <BrowserFields form={form} onChange={onChange} models={models} errors={errors} />
      ) : null}
    </>
  );
}
