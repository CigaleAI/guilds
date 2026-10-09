import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../cn";
import { Icon } from "../../primitives/Icon";
import { IconButton } from "../actions/IconButton";

export const banner = cva("flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-md px-3 py-2.5", {
  variants: {
    tone: {
      error: "bg-t-plum text-plum-t",
      warning: "bg-t-ochre text-t-ochre-fg",
      info: "bg-t-sig text-t-sig-fg",
      success: "bg-t-tide text-t-tide-fg",
    },
  },
  defaultVariants: { tone: "info" },
});

type BannerTone = NonNullable<VariantProps<typeof banner>["tone"]>;

const toneIcon: Record<BannerTone, LucideIcon> = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
  success: CircleCheck,
};

export type BannerProps = Omit<ComponentProps<"div">, "title"> &
  VariantProps<typeof banner> & {
    title: ReactNode;
    /** A mono line under the title: an error code, a limit, a timestamp. */
    meta?: ReactNode;
    /** One recovery step, such as an outline Retry button. */
    action?: ReactNode;
    /** Replaces the tone's icon. */
    icon?: LucideIcon;
    /** Shows a ✕ that calls this. */
    onDismiss?: () => void;
    dismissLabel?: string;
  };

/**
 * An inline notice at the top of a view or card: a load that failed, a limit coming up, a change
 * that landed. Errors and warnings are announced as alerts.
 */
export function Banner({
  tone,
  title,
  meta,
  action,
  icon,
  onDismiss,
  dismissLabel = "Dismiss",
  className,
  children,
  ...props
}: BannerProps) {
  const resolved = tone ?? "info";
  return (
    <div
      role={resolved === "error" || resolved === "warning" ? "alert" : "status"}
      className={cn(banner({ tone }), className)}
      {...props}
    >
      <Icon icon={icon ?? toneIcon[resolved]} />
      <div className="flex min-w-40 flex-1 flex-col gap-0.5">
        <span className="text-md font-semibold">{title}</span>
        {children ? <div className="text-sm">{children}</div> : null}
        {meta ? <span className="type-meta">{meta}</span> : null}
      </div>
      {action}
      {onDismiss ? (
        <IconButton
          icon={X}
          label={dismissLabel}
          variant="ghost"
          size={28}
          onClick={onDismiss}
          className="text-current hover:bg-paper"
        />
      ) : null}
    </div>
  );
}
