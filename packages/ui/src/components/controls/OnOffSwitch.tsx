import { ToggleGroup } from "radix-ui";
import { cn } from "../../cn";
import { Track, trackItem } from "../../primitives/Track";

/** Where a binding's value comes from: inherited down the org → guild → agent chain, or set here. */
export type BindingOrigin = { kind: "inherited"; from: string } | { kind: "overridden" } | { kind: "set" };

export type OnOffSwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Accessible name, such as the tool or integration it switches. */
  label: string;
  origin?: BindingOrigin;
  disabled?: boolean;
  className?: string;
};

/**
 * On/Off for a tool, integration or secret binding. A plum caption means this scope diverges from
 * the one above it; "Reset to inherit" lives with the list, not the switch.
 */
export function OnOffSwitch({ value, onValueChange, label, origin, disabled, className }: OnOffSwitchProps) {
  return (
    <div className={cn("inline-flex flex-col items-end gap-1", className)}>
      <ToggleGroup.Root
        type="single"
        value={value ? "on" : "off"}
        onValueChange={(next) => {
          if (next) onValueChange(next === "on");
        }}
        disabled={disabled ?? false}
        aria-label={label}
        asChild
      >
        <Track size="sm">
          <ToggleGroup.Item value="on" className={trackItem({ size: "sm", selectedFill: "accent", quiet: true })}>
            On
          </ToggleGroup.Item>
          <ToggleGroup.Item value="off" className={trackItem({ size: "sm", selectedFill: "plum", quiet: true })}>
            Off
          </ToggleGroup.Item>
        </Track>
      </ToggleGroup.Root>
      {origin && origin.kind !== "set" ? (
        <span className={cn("text-2xs", origin.kind === "overridden" ? "text-plum-t" : "text-muted")}>
          {origin.kind === "overridden" ? "overridden" : `inherited from ${origin.from}`}
        </span>
      ) : null}
    </div>
  );
}
