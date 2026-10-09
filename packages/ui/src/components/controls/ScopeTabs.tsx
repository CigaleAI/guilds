import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";

export type ScopeTab = {
  value: string;
  label: string;
  /** Items at this scope, such as note files. */
  count?: number;
};

export type ScopeTabsProps = ComponentProps<typeof RadixTabs.Root> & {
  scopes: readonly ScopeTab[];
  /** Accessible name of the tab row, such as "Note scope". */
  label: string;
};

/**
 * Full-width tabs across the agent → guild → org scopes, each with its count. The selected scope
 * is plum. Children are the scoped views (`TabsContent`).
 */
export function ScopeTabs({ scopes, label, className, children, ...props }: ScopeTabsProps) {
  return (
    <RadixTabs.Root className={cn("flex min-w-0 flex-col gap-3.5", className)} {...props}>
      <RadixTabs.List
        aria-label={label}
        className="grid auto-cols-fr grid-flow-col gap-1 rounded-full bg-well p-1 text-fg"
      >
        {scopes.map((scope) => (
          <RadixTabs.Trigger
            key={scope.value}
            value={scope.value}
            className={cn(
              "group/scope flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 py-2",
              "text-sm font-bold tracking-wider whitespace-nowrap uppercase transition-colors select-none",
              "hover:bg-surface selected:bg-plum selected:text-on-plum disabled:cursor-default disabled:text-faint",
            )}
          >
            <span className="truncate">{scope.label}</span>
            {scope.count !== undefined ? (
              <span className="rounded-sm bg-surface px-1 font-mono text-2xs tracking-normal text-fg tabular-nums group-data-[state=active]/scope:bg-dusk group-data-[state=active]/scope:text-on-plum">
                {scope.count}
              </span>
            ) : null}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}
