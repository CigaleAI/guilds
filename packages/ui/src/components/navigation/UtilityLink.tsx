import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { Tile } from "../../primitives/Tile";
import { cappedCount, CountBadge } from "../identity/CountBadge";

/** Each workspace tool keeps one tile colour, in the sidebar and on the collapsed rail. */
export type UtilityTone = "plum" | "signal" | "plum-tint" | "signal-tint" | "tide-tint" | "well";

/**
 * default is the roomy card with an optional subtitle. compact is the title-only row the
 * sidebar footer uses.
 */
export const utilityLink = cva(
  "flex w-full min-w-0 cursor-pointer items-center text-left text-fg transition-colors hover:bg-paper-hi selected:inset-ring-[1.5px] selected:inset-ring-fg",
  {
    variants: {
      density: {
        default: "gap-2.5 rounded-lg bg-paper px-2.5 py-1.5 md:gap-3 md:px-3 md:py-2.5",
        compact: "gap-2 rounded-md bg-paper px-2 py-1",
      },
    },
    defaultVariants: { density: "default" },
  },
);

export type UtilityLinkProps = Omit<ComponentProps<"button">, "title" | "children"> &
  VariantProps<typeof utilityLink> & {
    icon: LucideIcon;
    tone: UtilityTone;
    title: string;
    subtitle?: string;
    /** Items waiting, such as unread inbox entries. */
    count?: number;
    /** The tool open in the workspace. */
    selected?: boolean;
    /** Render the child element (a link) as the row. */
    asChild?: boolean;
    children?: ReactNode;
  };

/**
 * A workspace tool in the sidebar footer: Inbox, Studio, Builder, Recipes, Databases.
 * `default` is the roomy card with an optional subtitle; `compact` is the title-only row
 * the sidebar uses.
 */
export function UtilityLink({
  icon,
  tone,
  title,
  subtitle,
  count,
  selected,
  density,
  asChild,
  className,
  type,
  children,
  ...props
}: UtilityLinkProps) {
  const Comp = asChild ? Slot.Root : "button";
  const compact = density === "compact";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      aria-current={selected ? "page" : undefined}
      className={cn(utilityLink({ density }), className)}
      {...props}
    >
      <Tile size={compact ? 28 : 32} tone={tone} className={compact ? undefined : "md:size-9"}>
        <Icon icon={icon} size={compact ? 14 : 16} />
      </Tile>
      <span className={cn("flex min-w-0 flex-1 flex-col", compact && "leading-tight")}>
        <span className={cn("truncate font-semibold", compact ? "text-sm" : "text-md")}>
          {title}
        </span>
        {subtitle ? (
          <span className={cn("truncate text-muted", compact ? "text-2xs" : "text-xs")}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {count !== undefined && count > 0 ? <CountBadge>{cappedCount(count)}</CountBadge> : null}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Comp>
  );
}
