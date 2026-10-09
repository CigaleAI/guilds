import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { identityText, type IdentityTone } from "../../identity";
import { Avatar } from "./Avatar";

/**
 * `chip` is the static paper pill that names an agent in its identity colour. `strip` is one item
 * of the Studio agent strip: transparent until selected, then paper.
 */
export const agentChip = cva(
  "inline-flex max-w-full shrink-0 items-center gap-2 rounded-full whitespace-nowrap select-none",
  {
    variants: {
      variant: {
        chip: "bg-paper py-1 pr-3 pl-1",
        strip:
          "cursor-pointer py-1.5 pr-3.5 pl-1.5 text-fg transition-colors hover:bg-well selected:bg-paper selected:hover:bg-paper",
      },
    },
    defaultVariants: { variant: "chip" },
  },
);

export type AgentChipProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof agentChip> & {
    name: string;
    tone: IdentityTone;
    src?: string;
    /** Prompt version, such as "v8". */
    version?: ReactNode;
    /**
     * Render the child element (a button, a toggle-group or tab item) as the chip; avatar and
     * name go inside it. Selection follows the child's own state (aria-pressed, data-state).
     */
    asChild?: boolean;
    children?: ReactNode;
  };

/** An agent named by its avatar and handle, optionally with its prompt version. */
export function AgentChip({
  name,
  tone,
  src,
  version,
  variant,
  asChild,
  className,
  children,
  ...props
}: AgentChipProps) {
  const Comp = asChild ? Slot.Root : "span";
  const strip = variant === "strip";
  return (
    <Comp className={cn(agentChip({ variant }), className)} {...props}>
      <Avatar
        name={name}
        tone={tone}
        size={strip ? 24 : 28}
        {...(src ? { src } : {})}
        aria-hidden
      />
      <span
        className={cn(
          "min-w-0 truncate",
          strip ? "text-md font-semibold" : cn("text-sm font-bold", identityText[tone]),
        )}
      >
        {name}
      </span>
      {version !== undefined ? (
        <span className="font-mono text-2xs text-muted">{version}</span>
      ) : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
}
