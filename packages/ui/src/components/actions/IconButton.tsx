import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../cn";
import { Icon, type IconSize } from "../../primitives/Icon";

/** A square (or round) button holding one icon. Always carries an accessible label. */
export const iconButton = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors",
    "disabled:cursor-not-allowed disabled:bg-well disabled:text-faint disabled:shadow-none",
  ],
  {
    variants: {
      variant: {
        paper: "bg-paper text-fg hover:bg-paper-hi",
        surface: "bg-surface text-fg hover:bg-well",
        well: "bg-well text-fg hover:bg-paper",
        ink: "bg-ink-fill text-on-ink hover:bg-plum hover:text-on-plum",
        accent: "bg-signal text-on-signal hover:bg-signal-soft",
        plum: "bg-plum text-on-plum hover:opacity-90",
        ghost: "text-fg hover:bg-well",
        outline: "text-fg inset-ring-[1.5px] inset-ring-rule-2 hover:bg-paper",
        dashed: "border-[1.5px] border-dashed border-rule-2 text-fg hover:bg-paper",
        "on-plum": "bg-on-plum-hover text-on-plum hover:bg-on-plum-track",
      },
      size: {
        24: "size-6 rounded-sm",
        28: "size-7 rounded-sm",
        32: "size-8 rounded-md",
        36: "size-9 rounded-md",
        44: "size-11 rounded-lg",
      },
      round: {
        true: "rounded-full",
        false: "",
      },
    },
    defaultVariants: { variant: "paper", size: 36, round: false },
  },
);

const glyphSize: Record<24 | 28 | 32 | 36 | 44, IconSize> = { 24: 14, 28: 14, 32: 14, 36: 16, 44: 18 };

export type IconButtonProps = Omit<ComponentProps<"button">, "children"> &
  VariantProps<typeof iconButton> & {
    icon: LucideIcon;
    /** Accessible name. Pair with Tooltip where a visible hint helps. */
    label: string;
    asChild?: boolean;
  };

export function IconButton({
  icon,
  label,
  variant,
  size,
  round,
  asChild,
  className,
  type,
  ...props
}: IconButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type={asChild ? undefined : (type ?? "button")}
      aria-label={label}
      className={cn(iconButton({ variant, size, round }), className)}
      {...props}
    >
      <Icon icon={icon} size={glyphSize[size ?? 36]} />
    </Comp>
  );
}
